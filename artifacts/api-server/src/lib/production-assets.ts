import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db, charactersTable, characterAssetsTable, imageStudioAssetsTable, settingsTable, settingAssetsTable, type ProductionProjectRow } from "@workspace/db";
import { createImageJob, getImageJob, inspectImage, presentImageAsset } from "./image-studio-service";
import { mediaStorage } from "./storage-service";
import { getImageModel } from "./image-studio-models";
import { numberIn, text, type ProductionState, type ProductionTask } from "./production-types";
import { stateOf } from "./production-store";
import { publishProductionScenery } from "./scenery-library";

const MODEL = "local-flux2-klein-4b";
const views = ["front", "three-quarter", "profile", "expressions"];
export function addTask(state: ProductionState, type: ProductionTask["type"], entityId?: string, placeId?: string) {
  state.tasks.push({ id: randomUUID(), type, entityId, placeId, status: "QUEUED", index: 0 });
}
function requireIdle(state: ProductionState, id: string) {
  if (state.tasks.some(t => t.entityId === id && ["QUEUED", "RUNNING"].includes(t.status))) throw new Error("This item is still generating. Wait for it to finish.");
}
function flagCharacterScenes(state: ProductionState, id: string) {
  const character = state.characters.find(c => c.id === id)!;
  const affected = state.story.scenes.filter(s => s.characters.some(n => n.toLowerCase() === character.name.toLowerCase()));
  for (const scene of affected) if (!state.review.issues.some(i => i.id === `look-${id}-${scene.sceneNumber}`)) state.review.issues.push({
    id: `look-${id}-${scene.sceneNumber}`, sceneNumber: scene.sceneNumber,
    description: `${character.name}'s look changed. Review and re-render affected shots in scene ${scene.sceneNumber}.`,
    correction: `Use the newly locked appearance of ${character.name}.`,
  });
}
export async function mutateProductionAsset(row: ProductionProjectRow, action: string, payload: Record<string, unknown>) {
  const state = stateOf(row);
  if (action === "import-place") {
    const id = text(payload.settingId, "Location ID", 100);
    if (state.places.some(p => p.id === id)) return state;
    const [source] = await db.select().from(settingsTable).where(and(eq(settingsTable.id, id), eq(settingsTable.tenantId, row.tenantId)));
    if (!source) throw new Error("Location not found in this workspace.");
    const refs = await db.select().from(settingAssetsTable).where(eq(settingAssetsTable.settingId, id)).orderBy(asc(settingAssetsTable.sortOrder), asc(settingAssetsTable.createdAt));
    const images = [];
    for (const ref of refs.filter(ref => ref.mimeType.startsWith("image/"))) {
      let [asset] = await db.select().from(imageStudioAssetsTable).where(and(eq(imageStudioAssetsTable.tenantId, row.tenantId), eq(imageStudioAssetsTable.storageKey, ref.storageKey)));
      if (!asset) {
        const metadata = inspectImage(await mediaStorage.readBuffer(ref.storageKey), ref.mimeType);
        [asset] = await db.insert(imageStudioAssetsTable).values({ tenantId: row.tenantId, createdByUserId: row.createdByUserId, name: ref.originalName, storageKey: ref.storageKey, ...metadata }).returning();
      }
      images.push({ id: ref.id, name: ref.originalName, prompt: ref.description, assetId: asset.id, mediaUrl: presentImageAsset(asset).url, status: "READY" });
    }
    if (!images.length) throw new Error("This location has no reference image yet. Add one in Locations & Scenery first.");
    state.places.push({ id: source.id, name: source.name, prompt: source.promptDescription || source.description,
      seed: Math.floor(Math.random() * 2147483647), assetId: images[0].assetId, mediaUrl: images[0].mediaUrl,
      status: "READY", variants: images.slice(1) });
    return state;
  }
  if (action === "remove-place" || action === "remove-variant") {
    await publishProductionScenery(row);
    const place = state.places.find(p => p.id === payload.placeId);
    if (!place) throw new Error("Scenery not found in this production.");
    const ids = action === "remove-place" ? [place.id, ...place.variants.map(v => v.id)] : [text(payload.id, "Variant ID", 100)];
    if (action === "remove-variant" && !place.variants.some(v => v.id === ids[0])) throw new Error("Scenery variant not found.");
    for (const id of ids) requireIdle(state, id);
    if (action === "remove-place") state.places = state.places.filter(p => p.id !== place.id);
    else place.variants = place.variants.filter(v => !ids.includes(v.id));
    state.tasks = state.tasks.filter(t => !ids.includes(t.entityId ?? "") && !(action === "remove-place" && t.placeId === place.id));
    if (row.renderProjectId) state.review.issues.push({ id: `removed-${randomUUID()}`, description: `Scenery reference removed: ${place.name}. Existing rendered shots are retained; review their scenery.` });
    return state; // Detach from this production only; never delete shared media bytes.
  }
  if (action === "import-character") {
    const sourceId = text(payload.characterId, "Character ID", 100);
    if (state.characters.some(c => c.characterId === sourceId)) return state;
    if (state.characters.length >= 9) throw new Error("This production supports up to nine characters.");
    const [source] = await db.select().from(charactersTable).where(and(eq(charactersTable.id, sourceId), eq(charactersTable.tenantId, row.tenantId)));
    if (!source) throw new Error("Character not found in this workspace.");
    const references = await db.select().from(characterAssetsTable).where(eq(characterAssetsTable.characterId, source.id));
    const selected = references.find(a => a.isPrimary && a.mimeType.startsWith("image/")) ?? references.find(a => a.mimeType.startsWith("image/"));
    let image: { assetId: string; mediaUrl: string } | undefined;
    if (selected) {
      let [asset] = await db.select().from(imageStudioAssetsTable).where(and(eq(imageStudioAssetsTable.tenantId, row.tenantId), eq(imageStudioAssetsTable.storageKey, selected.storageKey)));
      if (!asset) {
        const metadata = inspectImage(await mediaStorage.readBuffer(selected.storageKey), selected.mimeType);
        [asset] = await db.insert(imageStudioAssetsTable).values({ tenantId: row.tenantId, createdByUserId: row.createdByUserId, name: selected.originalName, storageKey: selected.storageKey, ...metadata }).returning();
      }
      image = { assetId: asset.id, mediaUrl: presentImageAsset(asset).url };
    }
    state.characters.push({
      id: randomUUID(), characterId: source.id, name: source.name, description: source.promptDescription || source.description,
      seed: Math.floor(Math.random() * 2147483647), options: image ? [image] : [], selectedAssetId: image?.assetId,
      locked: !!image, referenceSheet: image ? [{ ...image, label: "existing look" }] : [], status: image ? "LOCKED" : "DRAFT",
    });
    return state; // Reuse the approved identity and reference, with no generation or spending.
  }
  const priorTasks = new Set(state.tasks.map(t => t.id));
  const modelId = payload.modelId === undefined ? MODEL : text(payload.modelId, "Image model", 100);
  const model = getImageModel(modelId);
  if (action !== "update-character") {
    if (!model) throw new Error("Choose a supported image model.");
    const edit = ["keep-look", "add-wardrobe", "add-variant"].includes(action);
    if (!model.operations.includes(edit ? "edit" : "generate") || (edit && model.maxReferences < 1)) throw new Error("This model cannot perform the required reference-conditioned operation.");
    if (model.provider === "CLOUD" && payload.cloudConfirmed !== true) throw new Error("Confirm the paid image batch before submitting. Portrait and reference-sheet batches each create four images.");
  }
  if (action === "add-character") {
    if (state.characters.length >= 9) throw new Error("This production supports up to nine characters.");
    const id = randomUUID();
    state.characters.push({
      id, name: text(payload.name, "Name", 180), description: text(payload.description, "Description"),
      seed: Math.floor(Math.random() * 2147483647), workflowId: modelId, options: [], locked: false, referenceSheet: [], status: "QUEUED",
    });
    addTask(state, "portraits", id);
  } else if (["regenerate-character", "update-character", "keep-look"].includes(action)) {
    const character = state.characters.find(c => c.id === payload.id);
    if (!character) throw new Error("Character not found in this project.");
    requireIdle(state, character.id);
    if (action === "keep-look") {
      const selected = character.options.find(o => o.assetId === payload.assetId);
      if (!selected) throw new Error("Choose one of this character's generated options.");
      const [asset] = await db.select().from(imageStudioAssetsTable).where(and(eq(imageStudioAssetsTable.id, selected.assetId), eq(imageStudioAssetsTable.tenantId, row.tenantId)));
      if (!asset) throw new Error("The selected portrait is no longer available.");
      // Store a private, project-owned image snapshot before exposing it to renders.
      if (!character.characterId) {
        const [created] = await db.insert(charactersTable).values({
          tenantId: row.tenantId, createdByUserId: row.createdByUserId,
          name: character.name, description: character.description, promptDescription: character.description,
          thumbnail: selected.mediaUrl,
        }).returning();
        character.characterId = created.id;
      } else {
        await db.update(charactersTable).set({ name: character.name, description: character.description, promptDescription: character.description, thumbnail: selected.mediaUrl }).where(and(eq(charactersTable.id, character.characterId), eq(charactersTable.tenantId, row.tenantId)));
      }
      await db.update(characterAssetsTable).set({ isPrimary: false }).where(eq(characterAssetsTable.characterId, character.characterId));
      await db.insert(characterAssetsTable).values({
        characterId: character.characterId, storageKey: asset.storageKey, originalName: `${character.name}-locked-look.png`,
        mimeType: asset.mimeType, label: "headshot", isPrimary: true, description: character.description,
      });
      character.selectedAssetId = selected.assetId; character.locked = true; character.status = "LOCKED";
      character.referenceSheet = [];
      addTask(state, "sheet", character.id);
    } else {
      if (row.renderProjectId) flagCharacterScenes(state, character.id);
      if (payload.name !== undefined) character.name = text(payload.name, "Name", 180);
      if (payload.description !== undefined) character.description = text(payload.description, "Description");
      if (action === "regenerate-character") {
        character.locked = false; character.options = []; character.referenceSheet = []; character.selectedAssetId = undefined;
        character.status = "QUEUED"; character.error = undefined;
        character.seed = Math.floor(Math.random() * 2147483647);
        character.workflowId = modelId;
        addTask(state, "portraits", character.id);
      }
    }
  } else if (action === "add-wardrobe") {
    const character = state.characters.find(c => c.id === payload.characterId);
    if (!character?.locked || !character.selectedAssetId) throw new Error("Lock the character's look before generating an outfit.");
    const fromScene = numberIn(payload.fromScene, "First scene", 1, state.story.scenes.length);
    const toScene = numberIn(payload.toScene, "Last scene", fromScene, state.story.scenes.length);
    const id = randomUUID();
    state.wardrobes.push({
      id, characterId: character.id, name: text(payload.name, "Outfit name", 180), prompt: text(payload.prompt, "Outfit prompt"),
      fromScene, toScene, status: "QUEUED",
      ...(payload.stateFromScene !== undefined ? { stateFromScene: numberIn(payload.stateFromScene, "State change scene", fromScene, toScene) } : {}),
      ...(payload.stateNote ? { stateNote: text(payload.stateNote, "State change", 1000) } : {}),
    });
    addTask(state, "wardrobe", id);
  } else if (action === "add-place") {
    const id = randomUUID();
    state.places.push({
      id, name: text(payload.name, "Place name", 180), prompt: text(payload.prompt, "Place prompt"), seed: Math.floor(Math.random() * 2147483647), variants: [], status: "QUEUED",
    });
    addTask(state, "place", id);
  } else if (action === "add-variant") {
    const place = state.places.find(p => p.id === payload.placeId);
    if (!place?.assetId) throw new Error("Generate the base location first.");
    const id = randomUUID();
    place.variants.push({ id, name: text(payload.name, "Variant name", 180), prompt: text(payload.prompt, "Variant prompt"), status: "QUEUED" });
    addTask(state, "variant", id, place.id);
  } else throw new Error("Unknown production action.");
  for (const task of state.tasks) if (!priorTasks.has(task.id)) {
    task.modelId = modelId; task.cloudConfirmed = model?.provider === "CLOUD" && payload.cloudConfirmed === true;
  }
  return state;
}

export async function advanceProductionImage(row: ProductionProjectRow, state: ProductionState, task: ProductionTask) {
  const character = state.characters.find(c => c.id === task.entityId);
  const outfit = state.wardrobes.find(w => w.id === task.entityId);
  const place = state.places.find(p => p.id === (task.placeId ?? task.entityId));
  const variant = task.type === "variant" ? place?.variants.find(v => v.id === task.entityId) : undefined;
  const entity = character ?? outfit ?? variant ?? place;
  if (!entity) throw new Error("The generation target no longer exists.");
  if (!task.jobId) {
    let prompt = "", referenceAssetIds: string[] = [], seed = 0, wide = false;
    if (task.type === "portraits" && character) {
      prompt = `Character portrait, one subject, clear face, no text. ${character.description}`;
      seed = character.seed + task.index;
    } else if (task.type === "sheet" && character?.selectedAssetId) {
      prompt = `Preserve the exact identity, facial structure and appearance of the reference. Create a ${views[task.index]} character reference view. ${character.description}`;
      seed = character.seed; referenceAssetIds = [character.selectedAssetId];
    } else if (task.type === "wardrobe" && outfit) {
      const identity = state.characters.find(c => c.id === outfit.characterId);
      if (!identity?.locked || !identity.selectedAssetId) throw new Error("The character look must be locked.");
      prompt = `Preserve the reference person's exact face and identity. Full-body outfit reference: ${outfit.prompt}`;
      seed = identity.seed; referenceAssetIds = [identity.selectedAssetId];
    } else if (task.type === "place" && place) {
      prompt = `Wide establishing reference of a location, consistent architecture and geography, no text: ${place.prompt}`;
      seed = place.seed; wide = true;
    } else if (task.type === "variant" && place?.assetId && variant) {
      prompt = `Preserve the reference location's exact layout, architecture and camera. Change only time of day or weather: ${variant.name}. ${variant.prompt}`;
      seed = place.seed; referenceAssetIds = [place.assetId]; wide = true;
    } else throw new Error("The required base reference is missing.");
    const job = await createImageJob({
      tenantId: row.tenantId, userId: row.createdByUserId,
      request: {
        modelId: task.modelId ?? MODEL, cloudConfirmed: task.cloudConfirmed === true,
        operation: referenceAssetIds.length ? "edit" : "generate",
        prompt, width: wide ? 1344 : 1024, height: wide ? 768 : 1024, count: 1,
        ...(getImageModel(task.modelId ?? MODEL)?.supportsSeed ? { seed } : {}),
        referenceAssetIds, requestKey: `${task.id.slice(0, -2)}${task.index.toString(16).padStart(2, "0")}`,
      },
    });
    task.jobId = job.id; task.status = "RUNNING"; entity.status = task.type === "sheet" ? "LOCKED" : "RUNNING";
    return;
  }
  const job = await getImageJob(row.tenantId, task.jobId);
  if (!job) throw new Error("The image job could not be found.");
  if (["FAILED", "CANCELLED"].includes(job.status)) throw new Error(job.errorMessage || "Image generation failed.");
  if (job.status !== "COMPLETED") return;
  const asset = job.assets[0];
  if (!asset) throw new Error("The image job completed without an image.");
  const image = { assetId: asset.id, mediaUrl: asset.url };
  if (task.type === "portraits" && character) character.options.push(image);
  else if (task.type === "sheet" && character) character.referenceSheet.push({ ...image, label: views[task.index] });
  else Object.assign(entity, image);
  task.index++;
  task.jobId = undefined;
  const total = task.type === "portraits" || task.type === "sheet" ? 4 : 1;
  if (task.index >= total) {
    task.status = "COMPLETED";
    entity.status = task.type === "sheet" ? "LOCKED" : "READY";
    if (task.type === "place" || task.type === "variant") {
      await publishProductionScenery({ ...row, state: state as unknown as Record<string, unknown> });
    }
  }
}

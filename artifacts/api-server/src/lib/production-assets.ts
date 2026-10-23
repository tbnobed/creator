import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, charactersTable, characterAssetsTable, imageStudioAssetsTable, settingsTable, settingAssetsTable, type ProductionProjectRow } from "@workspace/db";
import { createImageJob, getImageJob, inspectImage, presentImageAsset } from "./image-studio-service";
import { mediaStorage } from "./storage-service";
import { getImageModel } from "./image-studio-models";
import { numberIn, text, type ProductionState, type ProductionTask } from "./production-types";
import { stateOf } from "./production-store";
import { publishProductionScenery } from "./scenery-library";
import { publishProductionCharacters } from "./production-character-library";
import { openingInputs } from "./production-openings";

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
  if (["generate-scene-opening","set-scene-opening","approve-scene-opening"].includes(action)) {
    const scene=state.story.scenes.find(s=>s.sceneNumber===Number(payload.sceneNumber));
    if(!scene)throw new Error("Scene not found.");
    if(state.tasks.some(t=>["QUEUED","RUNNING"].includes(t.status)))throw new Error("Wait for reference generation to finish.");
    const {sourceKey}=openingInputs(state,scene);
    if(action==="approve-scene-opening") {
      if(!scene.opening?.assetId || scene.opening.assetId!==payload.assetId || scene.opening.sourceKey!==sourceKey)throw new Error("The opening image changed. Generate or upload and review a current composition.");
      scene.opening.approvedAssetId=scene.opening.assetId;
    } else if(action==="generate-scene-opening") {
      const correction=typeof payload.correction==="string" ? text(payload.correction,"Opening correction",2000,false) : "";
      const prior=scene.opening?.assetId;
      if(correction && !prior)throw new Error("Generate or upload an opening before correcting it.");
      scene.opening={status:"QUEUED",sourceKey};
      addTask(state,"opening",String(scene.sceneNumber));
      state.tasks.at(-1)!.modelId=MODEL;
      if(correction){state.tasks.at(-1)!.openingReferenceAssetId=prior;state.tasks.at(-1)!.openingCorrection=correction;}
    } else {
      const [asset]=await db.select().from(imageStudioAssetsTable).where(and(eq(imageStudioAssetsTable.tenantId,row.tenantId),eq(imageStudioAssetsTable.id,text(payload.assetId,"Opening image",100))));
      if(!asset)throw new Error("Opening image not found in this workspace.");
      scene.opening={assetId:asset.id,mediaUrl:presentImageAsset(asset).url,status:"READY",sourceKey};
    }
    return state;
  }
  if (["set-prop-reference", "approve-prop-reference", "remove-prop-reference"].includes(action)) {
    if (state.tasks.some(t => ["QUEUED", "RUNNING"].includes(t.status))) throw new Error("Wait for reference generation to finish.");
    if (action === "remove-prop-reference") delete state.propReference;
    else if (action === "approve-prop-reference") {
      if (!state.propReference || state.propReference.assetId !== payload.assetId) throw new Error("Review the current prop reference before approving.");
      state.propReference.approvedAssetId = state.propReference.assetId;
    } else {
      const id = text(payload.assetId, "Prop image", 100);
      const [asset] = await db.select().from(imageStudioAssetsTable).where(and(eq(imageStudioAssetsTable.id, id), eq(imageStudioAssetsTable.tenantId, row.tenantId)));
      if (!asset) throw new Error("Prop image not found in this workspace.");
      state.propReference = {assetId: id, mediaUrl: presentImageAsset(asset).url, description: text(payload.description, "Prop description", 2000)};
    }
    return state;
  }
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
  if (action === "approve-wardrobe") {
    const outfit = state.wardrobes.find(w => w.id === payload.id);
    if (!outfit?.assetId || outfit.status !== "READY" || outfit.assetId !== payload.assetId) throw new Error("Review the current completed outfit before approving it.");
    outfit.approvedAssetId = outfit.assetId;
    return state;
  }
  const priorTasks = new Set(state.tasks.map(t => t.id));
  const modelId = payload.modelId === undefined ? MODEL : text(payload.modelId, "Image model", 100);
  const model = getImageModel(modelId);
  if (action !== "update-character") {
    if (!model) throw new Error("Choose a supported image model.");
    if (action === "add-wardrobe" && model.provider === "LOCAL" && model.id !== "local-flux2-klein-4b") {
      throw new Error("This local model redraws the subject instead of editing clothing. Choose FLUX.2 Klein native reference editing or a supported cloud editing model.");
    }
    const edit = ["keep-look", "add-wardrobe", "add-variant"].includes(action);
    if (!model.operations.includes(edit ? "edit" : "generate") || (edit && model.maxReferences < 1)) throw new Error("This model cannot perform the required reference-conditioned operation.");
    if (model.provider === "CLOUD" && payload.cloudConfirmed !== true) throw new Error("Confirm the paid image batch before submitting. Portrait and reference-sheet batches each create four images.");
  }
  if (action === "add-character") {
    if (state.characters.length >= 9) throw new Error("This production supports up to nine characters.");
    const id = randomUUID();
    state.characters.push({
      id, name: typeof payload.name === "string" && payload.name.trim()
        ? text(payload.name, "Name", 180)
        : text(payload.description, "Description").split(/\s+/).slice(0, 6).join(" ").slice(0, 180),
      description: text(payload.description, "Description"),
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
        mimeType: asset.mimeType, label: "other", isPrimary: true, description: character.description,
      });
      character.selectedAssetId = selected.assetId; character.locked = true; character.status = "LOCKED";
      await db.update(charactersTable).set({
        dossierStatus: "DRAFT", dossierApprovedAt: null,
        dossierRevision: sql`${charactersTable.dossierRevision} + 1`,
      }).where(and(eq(charactersTable.id, character.characterId), eq(charactersTable.tenantId, row.tenantId)));
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
  await publishProductionCharacters(row, state);
  return state;
}

export async function advanceProductionImage(row: ProductionProjectRow, state: ProductionState, task: ProductionTask) {
  const openingScene=task.type==="opening" ? state.story.scenes.find(s=>String(s.sceneNumber)===task.entityId) : undefined;
  const character = state.characters.find(c => c.id === task.entityId);
  const outfit = state.wardrobes.find(w => w.id === task.entityId);
  const place = state.places.find(p => p.id === (task.placeId ?? task.entityId));
  const variant = task.type === "variant" ? place?.variants.find(v => v.id === task.entityId) : undefined;
  const entity = openingScene?.opening ?? character ?? outfit ?? variant ?? place;
  if (!entity) throw new Error("The generation target no longer exists.");
  if (!task.jobId) {
    let prompt = "", referenceAssetIds: string[] = [], seed = 0, wide = false;
    if (task.type==="opening" && openingScene) {
      const inputs=openingInputs(state,openingScene);
      if(inputs.ids.length>4 && !task.openingReferenceAssetId)throw new Error("Local scene composition supports at most four separate reference images. Upload a composed opening for this larger cast instead; no references were dropped.");
      prompt=task.openingCorrection
        ? `Edit this single complete scene image. Preserve its exact cast, faces, materials, outfits, props, room, lighting and camera except for this requested correction: ${task.openingCorrection}. Do not duplicate characters or objects.`
        : inputs.prompt;
      referenceAssetIds=task.openingReferenceAssetId ? [task.openingReferenceAssetId] : inputs.ids;wide=true;
    } else if (task.type === "portraits" && character) {
      prompt = `Character portrait, one subject, clear face, no text. ${character.description}`;
      seed = character.seed + task.index;
    } else if (task.type === "sheet" && character?.selectedAssetId) {
      prompt = `Preserve the exact identity, facial structure and appearance of the reference. Create a ${views[task.index]} character reference view. ${character.description}`;
      seed = character.seed; referenceAssetIds = [character.selectedAssetId];
    } else if (task.type === "wardrobe" && outfit) {
      const identity = state.characters.find(c => c.id === outfit.characterId);
      if (!identity?.locked || !identity.selectedAssetId) throw new Error("The character look must be locked.");
      prompt = `Edit only the clothing of the character in the supplied image. Keep the exact same character, face, eyes, head shape, body proportions, material, pose, camera and background. Do not redesign or replace the subject. Clothing change: ${outfit.prompt}`;
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
      ...(referenceAssetIds.length && (task.modelId ?? MODEL) === "local-flux2-klein-4b"
        ? { referenceMode: "native-reference-edit" as const } : {}),
      request: {
        modelId: task.modelId ?? MODEL, cloudConfirmed: task.cloudConfirmed === true,
        operation: referenceAssetIds.length ? "edit" : "generate",
        prompt, width: task.type==="opening" ? state.settings.width : wide ? 1344 : 1024, height: task.type==="opening" ? state.settings.height : wide ? 768 : 1024, count: 1,
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
  await publishProductionCharacters(row, state);
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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, productionProjectsTable, imageStudioAssetsTable, longFormProjectsTable, longFormShotsTable, workflowTemplatesTable, type ProductionProjectRow, type LongFormShot } from "@workspace/db";
import { productionWorkflowCapability } from "./comfy/production-capability";
import { stateOf } from "./production-store";
import { productionAppearance, approvedProductionProp } from "./production-appearance";
import { requireOpening } from "./production-openings";
import { requireProductionScenery } from "./production-scenery";
import { hasSevereExposureDrift, meanFrameBrightness, productionExposureForShot, requestsExposureChange } from "./production-exposure";
import { type ProductionScene } from "./production-types";
import { mediaStorage } from "./storage-service";
import { createLongFormProject, pauseLongFormProject, reassembleLongFormProject, retryLongFormShot, startLongFormProject, updateLongFormShot } from "./long-form-service";
import { createAndSubmitGeneration } from "./generation-service";
import { falModels, type FalModel } from "./fal/client";
import { registerProductionFrame, previousProductionShot } from "./production-dispatch";
import { productionRerenderPrompt, productionRetrySeed, productionShotPrompt } from "./production-shot-prompt";
import { prepareProductionRerenders } from "./production-rerender";

const exec = promisify(execFile);
export async function assertProductionEditable(row: ProductionProjectRow) {
  if (!row.renderProjectId) return;
  const [render] = await db.select().from(longFormProjectsTable).where(eq(longFormProjectsTable.id, row.renderProjectId));
  if (render && ["RUNNING", "ASSEMBLING"].includes(render.status)) throw new Error("Pause this project's renders before changing approved production elements.");
  const [active] = await db.select({ id: longFormShotsTable.id }).from(longFormShotsTable).where(and(
    eq(longFormShotsTable.projectId, row.renderProjectId),
    inArray(longFormShotsTable.status, ["QUEUED", "RENDERING", "PREPARING"]),
  )).limit(1);
  if (active) throw new Error("Wait for the active shot to finish after pausing before editing project content.");
}

export function productionShotPlan(scenes: ProductionScene[], defaultDuration: number) {
  return scenes.flatMap(scene => {
    const shots = scene.shots?.length ? scene.shots : [{ prompt: scene.action, dialogue: scene.dialogue, durationSeconds: defaultDuration }];
    return shots.map(shot => {
      // A draft must not compress a long spoken line into a short video.
      const words = (shot.dialogue.replace(/^[A-Z][A-Z .'-]*:\s*/gm, "")
        .replace(/^\s*\([^)]*\)\s*$/gm, "").match(/[\p{L}\p{N}]+/gu) ?? []).length;
      const durationSeconds = Math.max(shot.durationSeconds, Math.ceil(words / 2.1 + (words ? 2 : 0)));
      if (durationSeconds > 30) throw new Error(`Scene ${scene.sceneNumber} has dialogue too long for one shot. Split it into shorter shots before creating.`);
      return { ...shot, durationSeconds, sceneNumber: scene.sceneNumber };
    });
  });
}

export async function prepareProductionRender(row: ProductionProjectRow): Promise<string> {
  const state = stateOf(row);
  approvedProductionProp(state);
  for (const scene of state.story.scenes) requireOpening(state,scene);
  for (const scene of state.story.scenes) for (const character of state.characters.filter(c => scene.characters.some(n => n.toLowerCase() === c.name.toLowerCase()))) {
    const outfit = state.wardrobes.filter(w => w.characterId === character.id && w.fromScene <= scene.sceneNumber && w.toScene >= scene.sceneNumber).at(-1);
    if (outfit && (!outfit.assetId || outfit.approvedAssetId !== outfit.assetId)) throw new Error(`Review and approve ${character.name}'s ${outfit.name} in Wardrobe before rendering.`);
  }
  if (row.renderProjectId) return row.renderProjectId;
  if (!state.story.scenes.length || state.story.draftStatus !== "READY") throw new Error("Finish and review the story draft first.");
  if (state.tasks.some(t => ["QUEUED", "RUNNING"].includes(t.status))) throw new Error("Wait for the reference generation queue to finish.");
  if (!state.settings.generationMode) throw new Error("Select a video workflow in Create.");
  const names = new Set(state.story.scenes.flatMap(s => s.characters).map(n => n.toLowerCase()));
  for (const name of names) if (!state.characters.some(c => c.name.toLowerCase() === name && c.locked && c.characterId)) throw new Error(`Lock a look for ${name} before creating scenes.`);
  for (const scene of state.story.scenes) requireProductionScenery(state, scene);
  const shots = productionShotPlan(state.story.scenes, state.settings.shotDurationSeconds);
  const total = shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  if (total > 5400 || shots.length > 2700) throw new Error("The reviewed draft exceeds the 90-minute production limit. Shorten it before rendering.");
  // The existing planner accepts authored SHOT boundaries. Assign scene numbers
  // from the reviewed screenplay afterwards, rather than letting it infer them.
  const script = shots.map((shot, i) => `SHOT ${i + 1}\nVisual: ${shot.prompt}\n${shot.dialogue ? `Dialogue: ${shot.dialogue}\n` : ""}`).join("\n\n");
  const render = await createLongFormProject({
    tenantId: row.tenantId, createdByUserId: row.createdByUserId, title: row.title,
    // Story summaries and pasted screenplays are planning inputs, not shared visual style.
    script, targetDurationSeconds: total,
    ...state.settings,
    characterIds: state.characters.flatMap(c => c.characterId ? [c.characterId] : []),
    continuity: { enabled: false, characters: [], scenes: [] },
  });
  const created = await db.select().from(longFormShotsTable).where(eq(longFormShotsTable.projectId, render.id)).orderBy(asc(longFormShotsTable.sceneNumber), asc(longFormShotsTable.shotNumber));
  if (created.length !== shots.length) throw new Error("The render planner did not preserve all reviewed shot boundaries.");
  await db.transaction(async tx => {
    await tx.update(longFormShotsTable).set({ shotNumber: sql`${longFormShotsTable.shotNumber} + 100000` }).where(eq(longFormShotsTable.projectId, render.id));
    for (let i = 0; i < created.length; i++) {
      const planned = shots[i], scene = state.story.scenes.find(s => s.sceneNumber === planned.sceneNumber)!;
      const cast = state.characters.filter(c => scene.characters.some(n => n.toLowerCase() === c.name.toLowerCase())).flatMap(c => c.characterId ? [c.characterId] : []);
      await tx.update(longFormShotsTable).set({ sceneNumber: planned.sceneNumber, shotNumber: i + 1, durationSeconds: planned.durationSeconds, dialogue: planned.dialogue, characterIds: cast }).where(eq(longFormShotsTable.id, created[i].id));
    }
    await tx.update(productionProjectsTable).set({ renderProjectId: render.id }).where(eq(productionProjectsTable.id, row.id));
  });
  return render.id;
}

export async function runProductionRenderAction(row: ProductionProjectRow, action: string, payload: Record<string, unknown>) {
  if (action === "create-scenes" || action === "prepare-render") {
    const state = stateOf(row);
    if (state.settings.videoProvider !== "FAL") {
      const workflows = await db.select().from(workflowTemplatesTable).where(and(
        eq(workflowTemplatesTable.active, true),
        eq(workflowTemplatesTable.generationMode, state.settings.generationMode),
      ));
      const requiredSlots = Math.max(1, ...state.story.scenes.map(scene => {
        const cast = state.characters.filter(c => scene.characters.some(n => n.toLowerCase() === c.name.toLowerCase()));
        return 2 + (state.propReference ? 1 : 0);
      }));
      if (!workflows.some(workflow => {
        const capability = productionWorkflowCapability(workflow.apiWorkflow, workflow.mappings);
        return capability.supportsFirstFrame && capability.referenceImageSlots >= requiredSlots
          && !workflow.mappings.referenceVideo;
      })) {
        throw new Error(`This production requires a first-frame workflow with ${requiredSlots} separate character/scenery reference slots. The selected local workflow cannot supply both. No shots were submitted.`);
      }
    }
    if (state.settings.videoProvider === "FAL") {
      if (payload.cloudConfirmed !== true) throw new Error("Confirm the paid scene batch before rendering.");
      if (!state.settings.videoModel || !(state.settings.videoModel in falModels)) throw new Error("Select a supported Cloud video model.");
      state.settings.videoConfirmed = true;
      await db.update(productionProjectsTable).set({ state: state as unknown as Record<string, unknown> }).where(eq(productionProjectsTable.id, row.id));
    }
    const id = await prepareProductionRender(row);
    if (action === "create-scenes") await startLongFormProject(id, true);
    return id;
  }
  if (!row.renderProjectId) throw new Error("Create this project's scene queue first.");
  if (action === "export") {
    await reassembleLongFormProject(row.renderProjectId);
  } else if (action === "fix-shot") {
    if (stateOf(row).settings.videoProvider === "FAL" && payload.cloudConfirmed !== true) throw new Error("Confirm the paid shot re-render before rendering again.");
    if (stateOf(row).settings.videoProvider === "FAL") {
      stateOf(row).settings.videoConfirmed = true;
      await db.update(productionProjectsTable).set({ state: row.state }).where(eq(productionProjectsTable.id, row.id));
    }
    const shots = await db.select().from(longFormShotsTable).where(eq(longFormShotsTable.projectId, row.renderProjectId));
    const targets = shots.filter(s => payload.shotId ? s.id === payload.shotId : s.sceneNumber === payload.sceneNumber);
    if (!targets.length) throw new Error("Choose a shot belonging to this production.");
    if (targets.some(shot => ["QUEUED", "RENDERING"].includes(shot.status))) {
      throw new Error("Wait for the selected shot's current render to finish before correcting it.");
    }
    // Validate optional corrections before changing queue or shot state.
    const updates = targets.map(shot => ({ shot, prompt: productionRerenderPrompt(shot.prompt, payload.correction) }));
    await prepareProductionRerenders(row.renderProjectId, updates, {
      pause: pauseLongFormProject,
      update: updateLongFormShot,
      retry: retryLongFormShot,
      start: startLongFormProject,
    });
  } else throw new Error("Unknown rendering action.");
  return row.renderProjectId;
}

export async function dispatchProductionCloudShot(row: ProductionProjectRow, shot: LongFormShot, shots: LongFormShot[]) {
  const state = stateOf(row);
  if (!state.settings.videoConfirmed || !state.settings.videoModel || !(state.settings.videoModel in falModels)) throw new Error("The paid render batch needs explicit confirmation.");
  const refs = await productionShotReferences(row, shot, shots);
  const [claimed] = await db.update(longFormShotsTable).set({ status: "QUEUED", startedAt: new Date(), errorMessage: null })
    .where(and(eq(longFormShotsTable.id, shot.id), eq(longFormShotsTable.status, "PLANNED"))).returning();
  if (!claimed) return;
  try {
    await createAndSubmitGeneration({
      tenantId: row.tenantId, createdByUserId: row.createdByUserId, provider: "FAL", model: state.settings.videoModel as FalModel,
      generationMode: state.settings.generationMode, prompt: productionShotPrompt(shot.prompt, state.story.summary), dialogue: shot.dialogue,
      characterIds: [], cameraInstructions: shot.cameraInstructions, motionInstructions: shot.motionInstructions,
      durationSeconds: shot.durationSeconds, width: state.settings.width, height: state.settings.height,
      fps: state.settings.fps, qualityPreset: state.settings.qualityPreset, seedMode: "RANDOM",
      ...refs, seed: undefined, longFormShotId: shot.id,
      onJobCreated: async job => {
        await db.update(longFormShotsTable).set({ generationJobId: job.id, status: "RENDERING" }).where(eq(longFormShotsTable.id, shot.id));
      },
    });
  } catch (error) {
    const [current] = await db.select().from(longFormShotsTable).where(eq(longFormShotsTable.id, shot.id));
    // A provider receipt may already exist; reconcile that job rather than
    // marking it retryable and potentially submitting a second paid request.
    if (!current?.generationJobId) await db.update(longFormShotsTable).set({
      status: "FAILED", errorMessage: error instanceof Error ? error.message : "Cloud rendering failed.",
    }).where(eq(longFormShotsTable.id, shot.id));
  }
}

export async function productionForRender(projectId: string) {
  const [row] = await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.renderProjectId, projectId));
  return row;
}

export async function productionShotReferences(row: ProductionProjectRow, shot: LongFormShot, orderedShots: LongFormShot[]) {
  const state = stateOf(row);
  const scene = state.story.scenes.find(s => s.sceneNumber === shot.sceneNumber);
  if (!scene) throw new Error("This shot's production scene no longer exists.");
  const cast = state.characters.filter(c => scene.characters.some(n => n.toLowerCase() === c.name.toLowerCase()));
  const composed=requireOpening(state,scene);
  const ids: string[] = [composed.assetId!];
  const notes: string[] = ["Reference image 1 is the approved complete scene composition. Preserve its character identities, outfits, props, relative scale and entire location. Do not switch to a portrait background."];
  for (const character of cast) {
    const appearance = productionAppearance(state, character, scene.sceneNumber);
    notes.push(`In the approved composition: ${appearance.description}`);
  }
  const { place, reference: scenery } = requireProductionScenery(state, scene);
  ids.push(scenery.assetId!);
  notes.push(`Reference image ${ids.length} supplies location and lighting only, not character identity or clothing. Preserve prop shape, color, material and size relative to the characters throughout the shot.`);
  const prop = approvedProductionProp(state);
  if (prop) {
    ids.push(prop.assetId);
    notes.push(`Reference image ${ids.length} is the approved prop reference, not a replacement location or character. Preserve its exact object design, markings, material, color and relative scale: ${prop.description}`);
  }
  const assets = await db.select().from(imageStudioAssetsTable).where(and(eq(imageStudioAssetsTable.tenantId, row.tenantId), inArray(imageStudioAssetsTable.id, [...new Set(ids)])));
  if (assets.length !== new Set(ids).size) throw new Error("A locked production reference was removed. Restore it before rendering.");
  const keys = [...new Set(ids)].map(id => assets.find(a => a.id === id)!.storageKey);
  // A scene cut establishes the assigned new set. Only continue the previous
  // frame within the same scene, otherwise the old location anchors the cut.
  const previous = previousProductionShot(shot, orderedShots);
  // The opening shot uses the approved location plate; subsequent shots use
  // the actual previous output frame. Never leave firstFrame placeholders unset.
  let startFrameKey: string;
  if (previous) {
    if (previous.status !== "COMPLETED" || !previous.outputStorageKey) throw new Error("Waiting for the previous shot to finish before continuing its last frame.");
    const directory = await mkdtemp(path.join(tmpdir(), "production-last-frame-"));
    try {
      const output = path.join(directory, "frame.png");
      await exec("ffmpeg", ["-y", "-sseof", "-1", "-i", mediaStorage.resolvePath(previous.outputStorageKey), "-update", "1", output], { timeout: 60000, maxBuffer: 1024 * 1024 });
      // Preserve the exact final frame. Stop a severe unintended fade before
      // passing it to another sampler, rather than brightening it silently.
      if (!requestsExposureChange(previous.prompt) && !requestsExposureChange(shot.prompt)) {
        const opening = assets.find(a => a.id === composed.assetId)!;
        const [anchor, first, last] = await Promise.all([
          meanFrameBrightness(mediaStorage.resolvePath(opening.storageKey)),
          meanFrameBrightness(mediaStorage.resolvePath(previous.outputStorageKey)),
          meanFrameBrightness(output),
        ]);
        if (hasSevereExposureDrift(anchor, first, last)) {
          throw new Error(`Exposure drift detected after shot ${previous.shotNumber}: its ending is substantially darker than both its opening and the approved scene image. Correct and re-render that shot with stable lighting before continuing. The exact continuation frame has not been altered.`);
        }
      }
      startFrameKey = await mediaStorage.storeGenerationReferenceMedia("image/png", await readFile(output), row.tenantId);
    } finally { await rm(directory, { recursive: true, force: true }); }
  } else {
    const opening=assets.find(a=>a.id===composed.assetId);
    if(!opening)throw new Error("The approved opening image was removed.");
    startFrameKey = await registerProductionFrame(opening.storageKey, opening.mimeType, row.tenantId);
  }
  return {
    referenceImageKeys: keys, mandatoryReferenceImageCount: keys.length,
    explicitReferenceImagesOnly: true,
    startFrameKey, seed: productionRetrySeed(cast[0]?.seed ?? place.seed, shot.retryCount),
    continuityContext: `Location ${scene.location}, ${scene.timeOfDay}. ${productionExposureForShot(shot.prompt)} ${notes.join(". ")}`.slice(0, 5000),
  };
}

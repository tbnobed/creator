import { db, pool, productionProjectsTable, longFormProjectsTable, longFormShotsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { productionLock, saveProduction, stateOf } from "../lib/production-store";
import { mutateProductionAsset } from "../lib/production-assets";
import { runProductionRenderAction } from "../lib/production-render";
import { mediaStorage } from "../lib/storage-service";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const id = process.argv[2];
async function load() {
  const [row] = await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.id, id));
  if (!row) throw new Error("Verification project not found");
  return row;
}
async function waitIdle() {
  for (let i = 0; i < 360; i++) {
    const row = await load(), state = stateOf(row);
    const failed = state.tasks.find(t => t.status === "FAILED");
    if (failed) throw new Error(`${failed.type}: ${failed.error}`);
    if (!state.tasks.some(t => ["QUEUED", "RUNNING"].includes(t.status))) return row;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error("Timed out waiting for project tasks; inspect before resubmitting.");
}
async function act(action: string, payload: Record<string, unknown>) {
  return productionLock(id, async () => {
    const row = await load();
    return saveProduction(row, await mutateProductionAsset(row, action, payload));
  });
}
async function step(value: number) {
  await productionLock(id, async () => {
    const row = await load(), state = stateOf(row);
    state.step = value;
    await saveProduction(row, state);
  });
}
async function main() {
  let row = await waitIdle();
  console.log("STEP 1 completed: actual GPU screenplay task.", JSON.stringify(stateOf(row).story.scenes));
  await step(1);
  if (!stateOf(row).characters.length) {
    await act("add-character", { name: "Pip", description: "Pip, a small friendly wooden toy robot, rounded carved oak body, two dark circular eyes, articulated arms, full body, plain neutral backdrop." });
  }
  row = await waitIdle();
  let character = stateOf(row).characters[0];
  if (!character.locked) await act("keep-look", { id: character.id, assetId: character.options[0].assetId });
  row = await waitIdle();
  character = stateOf(row).characters[0];
  console.log("STEP 2 completed: four generated looks, approved look and reference sheet.", character.selectedAssetId);
  await step(2);
  if (!stateOf(row).wardrobes.length) await act("add-wardrobe", {
    characterId: character.id, name: "Blue vest",
    prompt: "Pip wears a simple royal blue fabric vest. Preserve the wooden robot identity.",
    fromScene: 1, toScene: stateOf(row).story.scenes.length,
  });
  row = await waitIdle();
  console.log("STEP 3 completed: generated wardrobe.", JSON.stringify(stateOf(row).wardrobes));
  await step(3);
  for (const location of [...new Set(stateOf(row).story.scenes.map(scene => scene.location))]) {
    row = await waitIdle();
    if (!stateOf(row).places.some(place => place.name === location)) {
      await act("add-place", {
        name: location,
        prompt: location.toUpperCase().includes("WORKSHOP")
          ? "Wide empty cozy wooden toy workshop, oak workbench, warm afternoon window light, wooden floor, no people, no robots, no text."
          : "Wide empty pale blue photography studio, seamless pale blue floor and backdrop, soft even daylight, no people, no robots, no text.",
      });
    }
  }
  row = await waitIdle();
  await productionLock(id, async () => {
    const current = await load(), state = stateOf(current);
    state.settings.sceneReferences = {};
    // The authored script explicitly names Pip; retain that cast selection.
    for (const scene of state.story.scenes) {
      const place = state.places.find(place => place.name === scene.location);
      if (!place?.assetId) throw new Error(`Missing generated scenery for ${scene.location}`);
      state.settings.sceneReferences[String(scene.sceneNumber)] = { placeId: place.id };
      scene.characters = ["Pip"];
    }
    state.step = 4;
    await saveProduction(current, state);
  });
  console.log("STEP 4 completed: generated scenery, assigned to scene. Ready for actual render preparation.");
  if (!process.argv.includes("--render")) return;
  let renderId: string;
  await productionLock(id, async () => {
    const current = await load();
    renderId = await runProductionRenderAction(current, "create-scenes", {});
  });
  console.log("STEP 5 submitted", renderId!);
  let lastProgress = "";
  for (let i = 0; i < 720; i++) {
    const [render] = await db.select().from(longFormProjectsTable).where(eq(longFormProjectsTable.id, renderId!));
    const shots = await db.select().from(longFormShotsTable).where(eq(longFormShotsTable.projectId, renderId!));
    const progress = JSON.stringify({ status: render.status, shots: shots.map(s => ({ scene: s.sceneNumber, shot: s.shotNumber, status: s.status, error: s.errorMessage })) });
    if (lastProgress !== progress) console.log(progress);
    lastProgress = progress;
    if (shots.some(s => s.status === "FAILED") || render.status === "FAILED") {
      throw new Error(`Real render failed: ${progress}. ${render.errorMessage ?? ""}`);
    }
    if (render.status === "COMPLETED" && render.finalOutputStorageKey) {
      await step(5);
      const directory = `/tmp/production-verification-${id}`;
      mkdirSync(directory, { recursive: true });
      for (const shot of shots) {
        if (!shot.outputStorageKey) throw new Error("Completed shot lacks output.");
        const file = mediaStorage.resolvePath(shot.outputStorageKey);
        execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
        execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-vf", "fps=1,scale=480:-1,tile=3x2", "-frames:v", "1", `${directory}/scene-${shot.sceneNumber}-shot-${shot.shotNumber}.png`]);
      }
      const output = mediaStorage.resolvePath(render.finalOutputStorageKey);
      execFileSync("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
      console.log("STEP 6 assembled output decodes", execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]).toString());
      console.log(JSON.stringify({ projectId: id, renderId: renderId!, outputKey: render.finalOutputStorageKey, contactSheets: directory, visualReviewRequired: true }));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  throw new Error("Observation timeout. Jobs left tracked in the project; inspect before retrying.");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());

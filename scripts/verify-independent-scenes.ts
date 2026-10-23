// Opt-in live GPU test. Copies a reviewed local production; never edits its source.
// Run from artifacts/api-server with the frontend's tsx binary.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { eq, asc } = require("drizzle-orm") as typeof import("../lib/db/node_modules/drizzle-orm");
import { db, pool, productionProjectsTable, longFormShotsTable, generationJobsTable, comfyServersTable } from "../lib/db/src/index";
import { stateOf } from "../artifacts/api-server/src/lib/production-store";
import { prepareProductionRender } from "../artifacts/api-server/src/lib/production-render";
import { startLongFormProject, pauseLongFormProject, orchestrateLongFormProject } from "../artifacts/api-server/src/lib/long-form-service";
import { ComfyUIClient } from "../artifacts/api-server/src/lib/comfy/client";

const sourceId = process.argv[2];
assert(sourceId, "Pass a reviewed local two-scene production ID; this submits real GPU work.");
const [source] = await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.id, sourceId));
assert(source);
const state = structuredClone(stateOf(source));
assert.equal(state.settings.videoProvider, "COMFYUI", "Never submit paid jobs from this test");
assert.equal(state.story.scenes.length, 2);
assert(state.story.scenes.every(scene => scene.shots?.length === 2), "Use two shots per scene");
// Exercise scheduling with locked cast/scenery only, not unapproved wardrobe drafts.
// The source production and its approvals remain untouched.
state.wardrobes = [];
state.step = 4;
const [copy] = await db.insert(productionProjectsTable).values({
  tenantId: source.tenantId, createdByUserId: source.createdByUserId,
  title: "Parallel GPU Verification — Two Independent Scenes",
  state: state as unknown as Record<string, unknown>,
}).returning();
const renderId = await prepareProductionRender(copy);
console.log(JSON.stringify({ productionId: copy.id, renderId }));
const shots = () => db.select().from(longFormShotsTable).where(eq(longFormShotsTable.projectId, renderId))
  .orderBy(asc(longFormShotsTable.sceneNumber), asc(longFormShotsTable.shotNumber));
await startLongFormProject(renderId);
let current = await shots();
const deadline = Date.now() + 180_000;
while (current.filter(s => s.status === "RENDERING").length < 2 && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 2000));
  current = await shots();
  assert(!current.some(s => s.status === "FAILED"), current.find(s => s.status === "FAILED")?.errorMessage || "");
}
const active = current.filter(s => s.status === "RENDERING");
assert.equal(active.length, 2, "Both scene openings must be active together");
assert.equal(new Set(active.map(s => s.sceneNumber)).size, 2);
assert.equal(new Set(active.map(s => s.assignedServerId)).size, 2, "Independent one-slot workers");
assert.deepEqual(current.map(s => s.status), ["RENDERING", "PLANNED", "RENDERING", "PLANNED"]);
for (const shot of active) {
  const [job] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, shot.generationJobId!));
  const [server] = await db.select().from(comfyServersTable).where(eq(comfyServersTable.id, shot.assignedServerId!));
  const queue = await new ComfyUIClient(server).getQueue();
  const entries = [...(queue.queue_running || []), ...(queue.queue_pending || [])] as unknown[][];
  assert(entries.some(entry => entry[1] === job.comfyPromptId), "Submitted prompt must appear in the real worker queue");
  console.log(JSON.stringify({ scene: shot.sceneNumber, worker: server.displayName, promptId: job.comfyPromptId,
    running: queue.queue_running?.length, pending: queue.queue_pending?.length }));
}
await pauseLongFormProject(renderId);
await orchestrateLongFormProject(renderId);
assert.deepEqual((await shots()).map(s => s.generationJobId), current.map(s => s.generationJobId));
console.log("PASS pause preserves both active jobs and submits no continuations");
await startLongFormProject(renderId);
console.log("PASS resumed; visible verification production retained for completion and UI checks");
// Keep this process's submission monitors alive until the workflow has consumed
// their outputs. The server orchestrator dispatches the dependent shots.
const completionDeadline = Date.now() + 20 * 60_000;
while (!(await shots()).every(s => s.status === "COMPLETED")) {
  assert(Date.now() < completionDeadline, "Live render timed out; inspect the retained project");
  const latest = await shots();
  assert(!latest.some(s => s.status === "FAILED"), latest.find(s => s.status === "FAILED")?.errorMessage || "");
  await new Promise(resolve => setTimeout(resolve, 5000));
}
const completed = await shots();
for (const scene of state.story.scenes) {
  const [first, second] = completed.filter(s => s.sceneNumber === scene.sceneNumber);
  assert(first.completedAt && second.startedAt && second.startedAt >= first.completedAt);
  assert(first.outputStorageKey && second.outputStorageKey);
}
console.log("PASS all four outputs completed in scene order; continuations started after predecessor completion");
await pool.end();
process.exit(0);

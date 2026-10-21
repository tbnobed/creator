// Explicit opt-in live smoke test. Uses installed local models only; no paid providers.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { outlineStory, expandScene } from "../artifacts/api-server/src/lib/production-story";
import { gpuStoryWriterConfig } from "../artifacts/api-server/src/lib/gpu-story-writer";

assert.ok(process.argv.includes("--live"), "Pass --live to run a real GPU writing request.");
const config = gpuStoryWriterConfig();
const began = Date.now();
let verifications = 0;
async function verified() {
  const ps = await (await fetch(`${config.baseUrl}/api/ps`)).json();
  const runner = ps.models?.find((m: any) => m.name === config.model);
  assert.ok(runner?.size_vram > 0, "The requested model must have GPU residency.");
  verifications++;
  console.log(JSON.stringify({ event: "GPU_VERIFIED", model: config.model, gpuGiB: +(runner.size_vram / 1024 ** 3).toFixed(2), elapsedSeconds: Math.round((Date.now() - began) / 1000) }));
}
const input = {
  title: "The Last Light at Gull Point", targetMinutes: 3, script: "",
  summary: "During a storm, lighthouse mechanic Mara and keeper Owen repair a failed beacon before a fishing boat reaches the rocks. Two characters, one lighthouse. Write two concise complete scenes with natural dialogue and a clear resolution.",
};
try {
  const scenes = await outlineStory(input, "local", verified);
  assert.ok(scenes.length > 0 && scenes.every(s => s.action && s.dialogue));
  console.log(JSON.stringify({ event: "SCENES_WRITTEN", scenes: scenes.length, elapsedSeconds: Math.round((Date.now() - began) / 1000) }));
  const expanded = await expandScene(scenes[0], { title: input.title, summary: input.summary, targetSeconds: 30, shotSeconds: 6 }, "local", verified);
  assert.equal(expanded.shots?.length, 5, "The bounded smoke test needs five six-second shots.");
  assert.ok(expanded.shots?.every(s => s.prompt && s.durationSeconds === 6));
  const ps = await (await fetch(`${config.baseUrl}/api/ps`)).json();
  assert.equal(ps.models?.some((m: any) => m.name === config.model), false, "Writer model must be unloaded after the test.");
  await writeFile("/tmp/gb10-story-writer-proof.json", JSON.stringify({ model: config.model, verifications, elapsedSeconds: Math.round((Date.now() - began) / 1000), scenes, expanded }, null, 2));
  console.log(JSON.stringify({ event: "PASSED", model: config.model, verifications, scenes: scenes.length, shots: expanded.shots?.length, modelUnloaded: true, elapsedSeconds: Math.round((Date.now() - began) / 1000) }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "GPU writer verification failed.");
  process.exitCode = 1;
}

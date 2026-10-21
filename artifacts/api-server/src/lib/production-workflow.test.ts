import test from "node:test";
import assert from "node:assert/strict";
import { emptyProduction } from "./production-types";
import { applyProductionPatch } from "./production-store";
import { mutateProductionAsset } from "./production-assets";
import { extractFdx } from "./production-script-upload";
import type { ProductionProjectRow } from "@workspace/db";

test("production drafts retain private server state and validate durations", () => {
  const state = emptyProduction();
  const next = applyProductionPatch(state, { step: 2, tasks: [{ type: "evil" }], settings: { imageModels: { characters: "cloud-nano-banana-pro" }, storyModel: "openai:gpt-4.1" }, story: { targetMinutes: 90 } });
  assert.equal(next.story.targetMinutes, 90);
  assert.equal(next.tasks.length, 0);
  assert.equal(next.settings.imageModels?.characters, "cloud-nano-banana-pro");
  assert.throws(() => applyProductionPatch(state, { story: { targetMinutes: 999 } }));
});
test("paid portrait batches require explicit permission and snapshot model selection", async () => {
  const row = { state: emptyProduction() } as unknown as ProductionProjectRow;
  const payload = { name: "Ari", description: "Harbor pilot", modelId: "cloud-nano-banana-pro" };
  await assert.rejects(mutateProductionAsset(row, "add-character", payload), /Confirm the paid/);
  const state = await mutateProductionAsset(row, "add-character", { ...payload, cloudConfirmed: true });
  assert.equal(state.tasks[0].modelId, payload.modelId);
  assert.equal(state.tasks[0].cloudConfirmed, true);
  assert.equal(state.characters[0].locked, false);
});
test("FDX text extraction preserves screenplay paragraphs and rejects entities", () => {
  assert.equal(extractFdx(Buffer.from('<FinalDraft><Paragraph><Text>A &amp; B</Text></Paragraph><Paragraph><Text>Hello.</Text></Paragraph></FinalDraft>')), "A & B\n\nHello.");
  assert.throws(() => extractFdx(Buffer.from('<!DOCTYPE x><FinalDraft/>')), /external entities/);
});
test("partial edits retain generated state and unrelated per-mode model choices", () => {
  const state = emptyProduction();
  state.story.summary = "Storm";
  state.tasks.push({ id: "writing", type: "story", status: "RUNNING" } as typeof state.tasks[number]);
  state.settings.imageModels = { places: "local-place-model", characters: "old-character-model" };
  const next = applyProductionPatch(state, { step: 4, story: { targetMinutes: 10 }, settings: { imageModels: { characters: "new-character-model" } } });
  assert.equal(next.story.summary, "Storm"); assert.equal(next.tasks[0].status, "RUNNING");
  assert.deepEqual(next.settings.imageModels, { places: "local-place-model", characters: "new-character-model" });
  assert.throws(() => applyProductionPatch(state, { story: { summary: "Changed while writing" } }), /Wait for story/);
});

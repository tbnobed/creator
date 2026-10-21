import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { callGpuStoryWriter } from "./gpu-story-writer";

const originalFetch = globalThis.fetch;
const prior = { url: process.env.STORY_AI_BASE_URL, model: process.env.STORY_AI_MODEL };
beforeEach(() => { process.env.STORY_AI_BASE_URL = "http://gb10.test:11434"; process.env.STORY_AI_MODEL = "qwen2.5:1.5b"; });
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [["STORY_AI_BASE_URL", prior.url], ["STORY_AI_MODEL", prior.model]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
});

function mockWriter({ vram = 1_000_000_000, name = "qwen2.5:1.5b", content = '{"scenes":[]}', reason = "stop" } = {}) {
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === "/api/tags") return Response.json({ models: [] });
    if (path === "/api/ps") return Response.json({ models: [{ name, size_vram: vram }] });
    if (path === "/api/generate") return Response.json({ done: true });
    if (path === "/api/chat" && body.options.num_predict === 1) return Response.json({ message: { content: "OK" }, done: true });
    return Response.json({ message: { content }, done: true, done_reason: reason });
  }) as typeof fetch;
  return calls;
}
test("missing dedicated endpoint never falls back to the prompt checker", async () => {
  const calls = mockWriter(); delete process.env.STORY_AI_BASE_URL;
  await assert.rejects(callGpuStoryWriter("Write scenes", {}), /CPU prompt checker is not used/);
  assert.equal(calls.length, 0);
});
test("CPU-only runner is refused before submitting screenplay content", async () => {
  const calls = mockWriter({ vram: 0 });
  await assert.rejects(callGpuStoryWriter("Write scenes", { privateStory: "content" }), /CPU-only script generation was refused/);
  assert.equal(calls.filter(c => c.path === "/api/chat").length, 1);
  assert.equal(calls.at(-1)?.path, "/api/generate");
});
test("verified GPU model receives the story and is unloaded afterward", async () => {
  const calls = mockWriter(); let verified = false;
  assert.deepEqual(await callGpuStoryWriter("Write scenes", { title: "Gull Point" }, async () => { verified = true; }), { scenes: [] });
  assert.equal(verified, true);
  const writing = calls.filter(c => c.path === "/api/chat")[1];
  assert.equal(writing.body.keep_alive, 0);
  assert.match(writing.body.messages[1].content, /Gull Point/);
  assert.equal(calls.at(-1)?.body.keep_alive, 0);
});
test("GPU residency of a different model does not qualify the requested writer", async () => {
  mockWriter({ name: "other-model:latest" });
  await assert.rejects(callGpuStoryWriter("Write scenes", {}), /not using GPU memory/);
});
test("network failure is explicit and does not use a second provider", async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(callGpuStoryWriter("Write scenes", {}), /Cannot reach the GB10/);
  assert.equal(requests, 1);
});
test("timeout gives a saved-input retry message", async () => {
  globalThis.fetch = (async () => { throw new DOMException("time", "TimeoutError"); }) as typeof fetch;
  await assert.rejects(callGpuStoryWriter("Write scenes", {}), /timed out.*input is saved/);
});
test("truncated and malformed model output are not accepted as completed drafts", async () => {
  mockWriter({ reason: "length" });
  await assert.rejects(callGpuStoryWriter("Write scenes", {}), /output limit/);
  const calls = mockWriter({ content: "not json" });
  await assert.rejects(callGpuStoryWriter("Write scenes", {}), /invalid JSON/);
  assert.equal(calls.at(-1)?.path, "/api/generate");
});

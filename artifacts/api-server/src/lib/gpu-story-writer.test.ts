import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { callGpuStoryWriter } from "./gpu-story-writer";

const originalFetch = globalThis.fetch;
const prior = { url: process.env.STORY_AI_BASE_URL, model: process.env.STORY_AI_MODEL, comfy: process.env.STORY_AI_COMFY_BASE_URL };
beforeEach(() => { process.env.STORY_AI_BASE_URL = "http://gb10.test:11434"; process.env.STORY_AI_COMFY_BASE_URL = "http://gb10.test:8188"; process.env.STORY_AI_MODEL = "qwen2.5:1.5b"; });
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [["STORY_AI_BASE_URL", prior.url], ["STORY_AI_MODEL", prior.model], ["STORY_AI_COMFY_BASE_URL", prior.comfy]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
});

function mockWriter({ vram = 1_000_000_000, name = "qwen2.5:1.5b", content = '{"scenes":[]}', reason = "stop", busy = false, memory = 100 * 1024 ** 3, occupied = false } = {}) {
  const calls: { path: string; body: any }[] = [];
  let psCalls = 0;
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === "/queue") return Response.json({ queue_running: busy ? [[1, "job"]] : [], queue_pending: [] });
    if (path === "/system_stats") return Response.json({ devices: [{ vram_free: memory }] });
    if (path === "/api/tags") return Response.json({ models: [{ name: "qwen2.5:1.5b", size: 1_000_000_000, capabilities: ["completion", "thinking"] }] });
    if (path === "/api/ps") return Response.json({ models: psCalls++ === 0 && !occupied ? [] : [{ name, size_vram: vram }] });
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
  assert.equal(writing.body.think, false);
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
test("video jobs and insufficient headroom block writing before model loading", async () => {
  let calls = mockWriter({ busy: true });
  await assert.rejects(callGpuStoryWriter("Write scenes", {}), /No GB10 writer worker is available/);
  assert.equal(calls.some(c => c.path === "/api/chat"), false);
  calls = mockWriter({ memory: 2 * 1024 ** 3 });
  await assert.rejects(callGpuStoryWriter("Write scenes", {}), /sufficient GPU memory/);
  assert.equal(calls.some(c => c.path === "/api/chat"), false);
});
test("an unrelated resident Ollama model is neither displaced nor unloaded", async () => {
  const calls = mockWriter({ occupied: true });
  await assert.rejects(callGpuStoryWriter("Write scenes", {}), /another Ollama model/);
  assert.equal(calls.some(c => ["/api/chat", "/api/generate"].includes(c.path)), false);
});
test("a video arriving during inference cancels writing and unloads its model", async () => {
  const calls = mockWriter();
  const mocked = globalThis.fetch;
  let queueReads = 0;
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/queue" && ++queueReads > 1) return Response.json({ queue_running: [[1, "new-video"]], queue_pending: [] });
    if (path === "/api/chat" && JSON.parse(String(init?.body)).options.num_predict === 8192) {
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
    }
    return mocked(url, init);
  }) as typeof fetch;
  const keepAlive = setTimeout(() => {}, 6000);
  try {
    await assert.rejects(callGpuStoryWriter("Write scenes", {}), /writing yielded to a video job/);
    assert.equal(calls.at(-1)?.path, "/api/generate");
  } finally { clearTimeout(keepAlive); }
});
test("missing installed model is refused without an automatic download", async () => {
  const calls = mockWriter();
  process.env.STORY_AI_MODEL = "not-installed:latest";
  await assert.rejects(callGpuStoryWriter("Write scenes", {}), /not installed/);
  assert.equal(calls.some(c => c.body), false);
});

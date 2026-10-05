import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { CheckPromptResponse, PolishPromptResponse } from "@workspace/api-zod";
import router from "./prompt-guidance";

test("local AI check and polish return validated results; disconnect aborts model work and frees its slot", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.PROMPT_AI_BASE_URL;
  process.env.PROMPT_AI_BASE_URL = "http://prompt-ai.test";
  let slow = false;
  let aborted = false;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith("http://prompt-ai.test")) return originalFetch(url, options);
    if (slow) {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
      });
    }
    const input = JSON.parse(String(options?.body));
    const polish = input.messages[0].content.includes("prompt editor");
    return new Response(JSON.stringify({ message: { content: JSON.stringify(polish
      ? { prompt: "A bird flies over a field.", cameraInstructions: "", motionInstructions: "", negativePrompt: "", dialogue: "", continuityNote: "" }
      : { summary: "Clear shot.", strengths: ["Clear subject"], issues: [] }) } }), { status: 200 });
  };
  const app = express();
  app.use(express.json(), router);
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const options = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "A bird flies over a field.", generationMode: "txt2vid" }) };
  try {
    const check = await originalFetch(`${base}/prompt-guidance/check`, options);
    assert.equal(check.status, 200);
    assert.equal(CheckPromptResponse.parse(await check.json()).summary, "Clear shot.");
    const polish = await originalFetch(`${base}/prompt-guidance/polish`, options);
    assert.equal(polish.status, 200);
    assert.equal(PolishPromptResponse.parse(await polish.json()).prompt, "A bird flies over a field.");
    slow = true;
    const controller = new AbortController();
    const pending = originalFetch(`${base}/prompt-guidance/check`, { ...options, signal: controller.signal }).catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 80));
    controller.abort();
    await pending;
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(aborted, true);
    slow = false;
    assert.equal((await originalFetch(`${base}/prompt-guidance/polish`, options)).status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.PROMPT_AI_BASE_URL;
    else process.env.PROMPT_AI_BASE_URL = originalUrl;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

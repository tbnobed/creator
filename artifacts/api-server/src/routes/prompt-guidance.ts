import { Router, type IRouter } from "express";
import { PolishPromptBody, PolishPromptResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 6;
const MAX_GLOBAL_CONCURRENCY = 4;
const clients = new Map<string, { startedAt: number; count: number; active: number }>();
let globalActive = 0;

function acquire(clientId: string): { ok: true; release: () => void } | { ok: false; status: number; error: string } {
  const now = Date.now();
  const previous = clients.get(clientId);
  const client = !previous || now - previous.startedAt >= WINDOW_MS
    ? { startedAt: now, count: 0, active: 0 }
    : previous;
  clients.set(clientId, client);
  if (client.count >= MAX_REQUESTS_PER_WINDOW) {
    return { ok: false, status: 429, error: "AI polish limit reached. Wait a minute and try again." };
  }
  if (client.active >= 1 || globalActive >= MAX_GLOBAL_CONCURRENCY) {
    return { ok: false, status: 429, error: "AI polish is busy. Wait for the current request and try again." };
  }
  client.count += 1;
  client.active += 1;
  globalActive += 1;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      client.active = Math.max(0, client.active - 1);
      globalActive = Math.max(0, globalActive - 1);
    },
  };
}

function extractJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

router.post("/prompt-guidance/polish", async (req, res): Promise<void> => {
  const input = PolishPromptBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }

  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseUrl || !apiKey) {
    res.status(503).json({ error: "AI polish is not configured. The prompt builder and checker are still available." });
    return;
  }
  const permit = acquire(req.ip || req.socket.remoteAddress || "unknown");
  if (!permit.ok) {
    res.status(permit.status).json({ error: permit.error });
    return;
  }

  const shotKind = input.data.shotKind ?? "SHOT";
  const instructions = [
    "You are a senior cinematic prompt editor for AI video generation.",
    "Improve clarity, physical plausibility, visual specificity, temporal consistency, and camera readability.",
    "Preserve the creator's intent, named subjects, dialogue, and requested action. Do not introduce new characters or brands.",
    "Keep each field concise. Avoid contradictory camera directions and keyword spam.",
    shotKind === "B-ROLL"
      ? "This is B-roll. Return an empty dialogue field and focus on visual coverage."
      : "This is a spoken shot. Preserve dialogue exactly unless only punctuation cleanup is needed.",
    "Return only a JSON object with exactly: prompt, cameraInstructions, motionInstructions, negativePrompt, dialogue, continuityNote.",
  ].join(" ");

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        max_completion_tokens: 1400,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: JSON.stringify(input.data) },
        ],
      }),
    });
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(payload.error?.message || `AI service returned ${response.status}`);
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI service returned an empty response");
    res.json(PolishPromptResponse.parse(extractJson(content)));
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error
        ? `AI polish failed: ${error.message}`
        : "AI polish failed. Your original prompt was not changed.",
    });
  } finally {
    permit.release();
  }
});

export default router;
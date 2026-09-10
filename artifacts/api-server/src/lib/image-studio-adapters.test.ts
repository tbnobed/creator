import assert from "node:assert/strict";
import test from "node:test";
import type { ComfyServer } from "@workspace/db";
import {
  ImageTaskError,
  pollImageTask,
  type ImageTask,
} from "./image-studio-adapters";

const cloudTask: ImageTask = {
  provider: "CLOUD",
  requestId: "request-1",
  metadata: {
    statusUrl: "https://queue.fal.run/requests/request-1/status",
    responseUrl: "https://queue.fal.run/requests/request-1",
    cancelUrl: "https://queue.fal.run/requests/request-1/cancel",
  },
};

const localServer: ComfyServer = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "Test worker",
  hostname: "192.0.2.1",
  apiBaseUrl: "https://192.0.2.1",
  websocketUrl: "wss://192.0.2.1/ws",
  gpuName: null,
  vramGb: null,
  tags: ["flux2-klein"],
  enabled: true,
  priority: 0,
  maxConcurrentJobs: 1,
  status: "ONLINE",
  queueSize: 0,
  activeJobCount: 0,
  memoryUsedGb: null,
  lastHeartbeat: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function expectTaskError(
  action: () => Promise<unknown>,
  retryable: boolean,
  status?: number,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ImageTaskError);
    assert.equal(error.retryable, retryable);
    assert.equal(error.status, status);
    return true;
  });
}

test("Cloud poll network failures remain retryable", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FAL_KEY;
  process.env.FAL_KEY = "test-key";
  globalThis.fetch = (async () => {
    throw new TypeError("fault injection");
  }) as typeof fetch;
  try {
    await expectTaskError(() => pollImageTask(cloudTask), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = originalKey;
  }
});

for (const status of [429, 503]) {
  test(`Cloud poll HTTP ${status} remains retryable`, async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.FAL_KEY;
    process.env.FAL_KEY = "test-key";
    globalThis.fetch = (async () => jsonResponse({}, status)) as typeof fetch;
    try {
      await expectTaskError(() => pollImageTask(cloudTask), true, status);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.FAL_KEY;
      else process.env.FAL_KEY = originalKey;
    }
  });
}

test("Cloud poll HTTP 400 is not retryable", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FAL_KEY;
  process.env.FAL_KEY = "test-key";
  globalThis.fetch = (async () => jsonResponse({}, 400)) as typeof fetch;
  try {
    await expectTaskError(() => pollImageTask(cloudTask), false, 400);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = originalKey;
  }
});

test("Cloud output download network failures remain retryable", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FAL_KEY;
  process.env.FAL_KEY = "test-key";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/status")) return jsonResponse({ status: "COMPLETED" });
    if (url.includes("queue.fal.run")) {
      return jsonResponse({
        images: [{
          url: "https://v3b.fal.media/files/b/test/output.png",
          content_type: "image/png",
          file_name: "output.png",
        }],
      });
    }
    throw new TypeError("download fault injection");
  }) as typeof fetch;
  try {
    await expectTaskError(() => pollImageTask(cloudTask), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = originalKey;
  }
});

for (const [status, retryable] of [[400, false], [429, true], [503, true]] as const) {
  test(`Cloud output download HTTP ${status} has retryable=${retryable}`, async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.FAL_KEY;
    process.env.FAL_KEY = "test-key";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/status")) return jsonResponse({ status: "COMPLETED" });
      if (url.includes("queue.fal.run")) {
        return jsonResponse({
          images: [{
            url: "https://v3b.fal.media/files/b/test/output.png",
            content_type: "image/png",
            file_name: "output.png",
          }],
        });
      }
      return jsonResponse({}, status);
    }) as typeof fetch;
    try {
      await expectTaskError(() => pollImageTask(cloudTask), retryable, status);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.FAL_KEY;
      else process.env.FAL_KEY = originalKey;
    }
  });
}

test("Local task missing beyond visibility grace is nonretryable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/history/")) return jsonResponse({});
    if (url.pathname === "/queue") return jsonResponse({ queue_running: [], queue_pending: [] });
    throw new Error(`Unexpected test URL: ${url.pathname}`);
  }) as typeof fetch;
  try {
    await expectTaskError(
      () => pollImageTask({
        provider: "LOCAL",
        requestId: "missing-prompt",
        metadata: {
          serverId: localServer.id,
          submittedAt: Date.now() - 60_000,
        },
        server: localServer,
      }),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Local polling never accepts another prompt's history output", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/history/")) {
      return jsonResponse({
        "another-tenants-prompt": {
          status: { status_str: "success", completed: true },
          outputs: { "1": { images: [{ filename: "private.png", subfolder: "", type: "output" }] } },
        },
      });
    }
    if (url.pathname === "/queue") return jsonResponse({ queue_running: [], queue_pending: [] });
    throw new Error("Unrelated output must never be downloaded");
  }) as typeof fetch;
  try {
    const result = await pollImageTask({
      provider: "LOCAL",
      requestId: "my-prompt",
      metadata: { serverId: localServer.id, submittedAt: Date.now() },
      server: localServer,
    });
    assert.equal(result.status, "QUEUED");
    assert.equal(result.images, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
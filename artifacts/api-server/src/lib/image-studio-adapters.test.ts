import assert from "node:assert/strict";
import test from "node:test";
import type { ComfyServer } from "@workspace/db";
import {
  ImageTaskError,
  checkLocalImageModel,
  pollImageTask,
  submitImageTask,
  type ImageTask,
  type ImageTaskInput,
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

const referencePng = (() => {
  const bytes = Buffer.alloc(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.writeUInt32BE(640, 16);
  bytes.writeUInt32BE(480, 20);
  return bytes;
})();

const localNodeClasses = [
  "UNETLoader",
  "CLIPLoader",
  "VAELoader",
  "CLIPTextEncode",
  "ConditioningZeroOut",
  "ModelSamplingAuraFlow",
  "EmptySD3LatentImage",
  "KSampler",
  "EmptyFlux2LatentImage",
  "Flux2Scheduler",
  "KSamplerSelect",
  "CFGGuider",
  "RandomNoise",
  "SamplerCustomAdvanced",
  "LoadImage",
  "ImageScale",
  "VAEEncode",
  "RepeatLatentBatch",
  "SplitSigmas",
  "VAEDecode",
  "SaveImage",
];

function localObjectInfo(missing: string | undefined = undefined): Record<string, unknown> {
  const info: Record<string, unknown> = {};
  for (const nodeClass of localNodeClasses) {
    if (nodeClass !== missing) info[nodeClass] = {};
  }
  info.UNETLoader = { input: { required: { unet_name: [["qwen_image_2512_fp8_e4m3fn.safetensors", "z_image_turbo_bf16.safetensors", "flux-2-klein-4b.safetensors"]] } } };
  info.CLIPLoader = { input: { required: { clip_name: [["qwen_2.5_vl_7b_fp8_scaled.safetensors", "qwen_3_4b.safetensors"]] } } };
  info.VAELoader = { input: { required: { vae_name: [["qwen_image_vae.safetensors", "ae.safetensors", "flux2-vae.safetensors"]] } } };
  return info;
}

function localInput(
  modelId: string,
  reference = true,
  options: { count?: number; denoiseStrength?: number } = {},
): ImageTaskInput {
  const requiredTag = modelId === "local-qwen-image-2512"
    ? "qwen-image-2512"
    : modelId === "local-z-image-turbo"
      ? "z-image-turbo"
      : "flux2-klein";
  return {
    modelId,
    operation: reference ? "edit" : "generate",
    prompt: "A test image",
    width: 768,
    height: 512,
    seed: 42,
    count: options.count ?? 1,
    ...(reference
      ? {
        denoiseStrength: options.denoiseStrength ?? 0.7,
        referenceImages: [{ bytes: referencePng, mimeType: "image/png" }],
      }
      : { referenceImages: [] }),
    clientId: `test-${modelId}`,
    server: { ...localServer, tags: [requiredTag] },
  };
}

async function submitMockedLocal(
  input: ImageTaskInput,
  missingNode?: string,
): Promise<{ workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>; uploadCount: number; metadata: Record<string, unknown> }> {
  const originalFetch = globalThis.fetch;
  let uploadCount = 0;
  let workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }> | undefined;
  globalThis.fetch = (async (inputValue: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(inputValue));
    if (url.pathname === "/object_info") return jsonResponse(localObjectInfo(missingNode));
    if (url.pathname === "/upload/image") {
      uploadCount += 1;
      return jsonResponse({ name: "uploaded-reference.png" });
    }
    if (url.pathname === "/prompt") {
      workflow = JSON.parse(String(init?.body)).prompt;
      return jsonResponse({ prompt_id: "prompt-test" });
    }
    throw new Error(`Unexpected test URL: ${url.pathname}`);
  }) as typeof fetch;
  try {
    const submitted = await submitImageTask(input);
    assert.ok(workflow);
    return { workflow, uploadCount, metadata: submitted.metadata };
  } finally {
    globalThis.fetch = originalFetch;
  }
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

for (const modelId of ["local-qwen-image-2512", "local-z-image-turbo", "local-flux2-klein-4b"]) {
  test(`${modelId} submits a scaled VAE-encoded reference latent`, async () => {
    const result = await submitMockedLocal(localInput(modelId));
    assert.equal(result.uploadCount, 1);
    assert.equal(result.metadata.denoiseStrength, 0.7);
    const load = Object.values(result.workflow).find((node) => node.class_type === "LoadImage");
    const scale = Object.values(result.workflow).find((node) => node.class_type === "ImageScale");
    const encode = Object.values(result.workflow).find((node) => node.class_type === "VAEEncode");
    assert.deepEqual(load?.inputs.image, "uploaded-reference.png");
    assert.deepEqual(scale?.inputs, {
      image: [load && Object.entries(result.workflow).find(([, node]) => node === load)?.[0], 0],
      upscale_method: "lanczos",
      width: 768,
      height: 512,
      crop: "disabled",
    });
    assert.ok(encode);
    assert.deepEqual(encode.inputs.pixels, [
      Object.entries(result.workflow).find(([, node]) => node === scale)?.[0],
      0,
    ]);
    const repeat = Object.values(result.workflow).find((node) => node.class_type === "RepeatLatentBatch");
    assert.ok(repeat);
    assert.deepEqual(repeat.inputs.samples, [
      Object.entries(result.workflow).find(([, node]) => node === encode)?.[0],
      0,
    ]);
    assert.equal(repeat.inputs.amount, 1);
    if (modelId === "local-flux2-klein-4b") {
      assert.deepEqual(result.workflow["11"].inputs.latent_image, ["18", 0]);
      assert.deepEqual(result.workflow["11"].inputs.sigmas, ["17", 1]);
      assert.equal(result.workflow["7"].inputs.steps, 5);
      assert.equal(result.workflow["17"].class_type, "SplitSigmas");
      assert.equal(result.workflow["17"].inputs.step, 1);
    } else {
      assert.deepEqual(result.workflow["8"].inputs.latent_image, ["14", 0]);
      assert.equal(result.workflow["8"].inputs.denoise, 0.7);
    }
  });

  test(`${modelId} keeps the original text-to-image graph without a reference`, async () => {
    const result = await submitMockedLocal(localInput(modelId, false));
    assert.equal(result.uploadCount, 0);
    assert.equal(Object.values(result.workflow).some((node) => node.class_type === "LoadImage"), false);
    assert.equal(Object.values(result.workflow).some((node) => node.class_type === "ImageScale"), false);
    assert.equal(Object.values(result.workflow).some((node) => node.class_type === "VAEEncode"), false);
    assert.equal(Object.values(result.workflow).some((node) => node.class_type === "RepeatLatentBatch"), false);
    assert.equal(Object.values(result.workflow).some((node) => node.class_type === "SplitSigmas"), false);
    if (modelId === "local-flux2-klein-4b") {
      assert.deepEqual(result.workflow["11"].inputs.latent_image, ["6", 0]);
      assert.deepEqual(result.workflow["11"].inputs.sigmas, ["7", 0]);
    } else {
      assert.deepEqual(result.workflow["8"].inputs.latent_image, ["7", 0]);
      assert.equal(result.workflow["8"].inputs.denoise, 1);
    }
  });
}

for (const denoiseStrength of [0.05, 0.65, 1]) {
  test(`Flux reference schedule preserves four transitions at denoise ${denoiseStrength}`, async () => {
    const result = await submitMockedLocal(
      localInput("local-flux2-klein-4b", true, { denoiseStrength }),
    );
    const expandedSteps = Math.max(4, Math.floor(4 / denoiseStrength));
    assert.equal(result.workflow["7"].inputs.steps, expandedSteps);
    assert.equal(result.workflow["17"].class_type, "SplitSigmas");
    assert.equal(result.workflow["17"].inputs.step, expandedSteps - 4);
    assert.deepEqual(result.workflow["11"].inputs.sigmas, ["17", 1]);
  });
}

for (const modelId of ["local-qwen-image-2512", "local-z-image-turbo", "local-flux2-klein-4b"]) {
  test(`${modelId} repeats the encoded reference for every requested output`, async () => {
    const result = await submitMockedLocal(localInput(modelId, true, { count: 3 }));
    const repeatNode = Object.values(result.workflow).find((node) => node.class_type === "RepeatLatentBatch");
    assert.ok(repeatNode);
    assert.equal(repeatNode.inputs.amount, 3);
    if (modelId === "local-flux2-klein-4b") {
      assert.deepEqual(result.workflow["11"].inputs.latent_image, ["18", 0]);
      assert.deepEqual(repeatNode.inputs.samples, ["16", 0]);
    } else {
      assert.deepEqual(result.workflow["8"].inputs.latent_image, ["14", 0]);
      assert.deepEqual(repeatNode.inputs.samples, ["13", 0]);
    }
  });
}

test("Local submission rejects invalid denoise strength before worker inspection", async () => {
  await assert.rejects(
    () => submitImageTask({
      ...localInput("local-qwen-image-2512"),
      denoiseStrength: 0.04,
    }),
    /Denoise strength must be a number from 0\.05 to 1/,
  );
});

test("Local text-to-image submission rejects denoise strength without a reference", async () => {
  await assert.rejects(
    () => submitImageTask({
      ...localInput("local-qwen-image-2512", false),
      denoiseStrength: 0.65,
    }),
    /Denoise strength requires a reference image/,
  );
});

test("Local model capability check fails closed when an image-to-image node is absent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/object_info") return jsonResponse(localObjectInfo("ImageScale"));
    throw new Error(`Unexpected test URL: ${url.pathname}`);
  }) as typeof fetch;
  try {
    assert.equal(await checkLocalImageModel("local-qwen-image-2512", localServer), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const missingNode of ["RepeatLatentBatch", "SplitSigmas"]) {
  test(`Local capability check fails closed when ${missingNode} is absent`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/object_info") return jsonResponse(localObjectInfo(missingNode));
      throw new Error(`Unexpected test URL: ${url.pathname}`);
    }) as typeof fetch;
    try {
      const modelId = missingNode === "SplitSigmas" ? "local-flux2-klein-4b" : "local-qwen-image-2512";
      assert.equal(await checkLocalImageModel(modelId, {
        ...localServer,
        tags: [modelId === "local-flux2-klein-4b" ? "flux2-klein" : "qwen-image-2512"],
      }), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
#!/usr/bin/env node
// Durable character-image generation regression harness.
//
// This harness deliberately uses an ephemeral HTTP Comfy-compatible worker and
// never submits to a configured GPU. It is opt-in because adding a temporary
// worker row is not safe during normal development:
//
//   DURABLE_CHARACTER_TEST=1 node scripts/test-durable-character-generation.mjs
//
// To rerun only the browser lifecycle after API/restart stages have passed:
//
//   DURABLE_CHARACTER_TEST=1 DURABLE_CHARACTER_UI_ONLY=1 \
//     node scripts/test-durable-character-generation.mjs
//
// The API contract is deliberately exercised through the stable character
// endpoint and dossier imageGeneration record. It remains strict about
// lifecycle semantics: a request must be acknowledged as a durable job in
// under two seconds, terminal attachment must be idempotent, and all job reads
// remain tenant-scoped.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, scrypt } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { rm } from "node:fs/promises";
import { chromium } from "@playwright/test";

if (process.env.NODE_ENV === "production") throw new Error("Development test only");
if (process.env.DURABLE_CHARACTER_TEST !== "1") {
  throw new Error(
    "Refusing to run without DURABLE_CHARACTER_TEST=1; this harness creates an ephemeral mocked-worker fixture.",
  );
}
if (!process.env.REPLIT_DEV_DOMAIN) throw new Error("REPLIT_DEV_DOMAIN is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/repl/tools/bin/chromium";
const runId = randomUUID();
const uiOnly = process.env.DURABLE_CHARACTER_UI_ONLY === "1";
const screenshotRoot = process.env.DURABLE_CHARACTER_SCREENSHOT_DIR || "/tmp";
const fixtures = [];
const characterIds = [];
const workerIds = [];
let browser;
let fakeWorker;

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mNkYGD4z8DAwMDAwMDAAAwBAAEGAPr9C8cAAAAASUVORK5CYII=",
  "base64",
);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function json(value) {
  return JSON.stringify(value);
}

function safeError(error) {
  const detail = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  return detail
    .replace(/(?:postgres(?:ql)?):\/\/\S+/gi, "[database connection redacted]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[credentials-redacted]@")
    .replace(/obtv_session=[^;\s]+/gi, "obtv_session=[session redacted]");
}

function stageLog(message) {
  console.log(`[durable-character ${runId.slice(0, 8)}] ${message}`);
}

async function runStage(name, operation) {
  stageLog(`START ${name}`);
  try {
    const result = await operation();
    stageLog(`PASS ${name}`);
    return result;
  } catch (error) {
    stageLog(`FAIL ${name}\n${safeError(error)}`);
    throw error;
  }
}

function firstNonLoopbackAddress() {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
        return entry.address;
      }
    }
  }
  throw new Error("The mocked worker needs a non-loopback IPv4 address");
}

function parseJsonRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (!chunks.length) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.length,
  });
  response.end(payload);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function multipartFileBytes(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]?.trim();
  if (!boundary) return null;
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"));
  if (headerEnd < 0) return null;
  const contentStart = headerEnd + 4;
  const contentEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
  if (contentEnd < 0) return null;
  return body.subarray(contentStart, contentEnd);
}

function pngDimensions(bytes) {
  if (!bytes || bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function pngHistory(promptId, filename) {
  return {
    [promptId]: {
      status: { status_str: "success", completed: true, messages: [] },
      outputs: {
        "1": {
          images: [{ filename, subfolder: "", type: "output" }],
        },
      },
    },
  };
}

function objectInfo() {
  // The durable character path may perform the same capability probe as Image
  // Studio. These node names are only worker metadata; no inference is run.
  // This shared-environment harness intentionally keeps the worker capable;
  // missing-native-capability fail-closed behavior belongs in isolated
  // adapter/selection unit tests, not a POST that may scan another worker.
  const info = {
    UNETLoader: {},
    CLIPLoader: {},
    VAELoader: {},
    CLIPTextEncode: {},
    ConditioningZeroOut: {},
    EmptyFlux2LatentImage: {},
    Flux2Scheduler: {},
    KSamplerSelect: {},
    CFGGuider: {},
    RandomNoise: {},
    SamplerCustomAdvanced: {},
    LoadImage: {},
    ImageScale: {
      input: {
        required: {
          image: ["IMAGE"],
          upscale_method: [["nearest-exact"]],
          width: ["INT", { default: 1024, min: 1 }],
          height: ["INT", { default: 0, min: 0 }],
          crop: [["disabled"]],
        },
      },
    },
    VAEEncode: {},
    RepeatLatentBatch: {},
    SplitSigmas: {},
    VAEDecode: {},
    SaveImage: {},
    ImageScaleToTotalPixels: {
      input: {
        required: {
          image: ["IMAGE"],
          upscale_method: [["nearest-exact"]],
          megapixels: ["FLOAT", { default: 1, min: 0.01 }],
          resolution_steps: ["INT", { default: 1, min: 1 }],
        },
      },
    },
    ReferenceLatent: {
      input: {
        required: { conditioning: ["CONDITIONING"] },
        optional: { latent: ["LATENT"] },
      },
    },
  };
  info.UNETLoader = {
    input: { required: { unet_name: [["flux-2-klein-4b.safetensors"]] } },
  };
  info.CLIPLoader = {
    input: { required: { clip_name: [["qwen_3_4b.safetensors"]] } },
  };
  info.VAELoader = {
    input: { required: { vae_name: [["flux2-vae.safetensors"]] } },
  };
  return info;
}

async function startMockWorker() {
  const state = {
    mode: "complete",
    submissions: 0,
    histories: new Map(),
    historyReads: new Map(),
    requests: [],
    workflows: [],
    uploads: [],
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://worker.invalid");
    state.requests.push({ method: request.method, pathname: url.pathname });
    if (request.method === "GET" && url.pathname.startsWith("/object_info")) {
      sendJson(response, 200, objectInfo());
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/models/")) {
      sendJson(response, 200, ["flux-2-klein-4b.safetensors"]);
      return;
    }
    if (request.method === "GET" && url.pathname === "/system_stats") {
      sendJson(response, 200, { system: { os: "test", runtime_version: "fixture" } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/queue") {
      const active = [...state.histories.entries()]
        .filter(([, value]) => value.mode === "prolonged")
        .map(([id]) => [id, {}, id]);
      sendJson(response, 200, { queue_running: active, queue_pending: [] });
      return;
    }
    if (request.method === "POST" && url.pathname === "/upload/image") {
      const body = await readRequestBody(request);
      const contentType = request.headers["content-type"] ?? "";
      const name = `durable-character-${state.uploads.length + 1}.png`;
      state.uploads.push({
        body,
        name,
        contentType,
        fileBytes: multipartFileBytes(body, contentType),
      });
      sendJson(response, 200, { name, subfolder: "", type: "input" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/prompt") {
      const body = await parseJsonRequest(request);
      const promptId = `durable-character-prompt-${state.submissions + 1}`;
      state.submissions += 1;
      state.workflows.push({
        promptId,
        workflow: body?.prompt ?? null,
        clientId: body?.client_id ?? null,
      });
      state.histories.set(promptId, {
        mode: state.mode,
        workflow: body?.prompt ?? null,
      });
      state.historyReads.set(promptId, 0);
      sendJson(response, 200, { prompt_id: promptId });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/history/")) {
      const promptId = decodeURIComponent(url.pathname.slice("/history/".length));
      const current = state.histories.get(promptId);
      if (!current) {
        sendJson(response, 200, {});
        return;
      }
      const reads = (state.historyReads.get(promptId) ?? 0) + 1;
      state.historyReads.set(promptId, reads);
      if (current.mode === "transient" && reads === 1) {
        sendJson(response, 503, { error: "temporary mocked worker outage" });
        return;
      }
      if (current.mode === "prolonged") {
        sendJson(response, 200, {});
        return;
      }
      if (current.mode === "failure") {
        sendJson(response, 200, {
          [promptId]: {
            status: {
              status_str: "error",
              messages: [["execution_error", "<html>mock worker error</html>"]],
            },
          },
        });
        return;
      }
      sendJson(response, 200, pngHistory(promptId, `${promptId}.png`));
      return;
    }
    if (request.method === "GET" && url.pathname === "/view") {
      response.writeHead(200, { "content-type": "image/png", "content-length": tinyPng.length });
      response.end(tinyPng);
      return;
    }
    if (request.method === "POST" && (url.pathname === "/queue" || url.pathname === "/interrupt")) {
      sendJson(response, 200, {});
      return;
    }
    sendJson(response, 404, { error: "mock worker route not found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object" && address.port, "Mock worker did not bind a port");
  const host = process.env.DURABLE_CHARACTER_FAKE_WORKER_HOST || firstNonLoopbackAddress();
  return {
    state,
    server,
    apiBaseUrl: `http://${host}:${address.port}`,
    websocketUrl: `ws://${host}:${address.port}/ws`,
    setMode(mode) {
      assert(["complete", "prolonged", "transient", "failure"].includes(mode));
      state.mode = mode;
      // A prolonged prompt is intentionally held until the test advances the
      // mocked worker. This lets the same accepted prompt become completed
      // without issuing a second /prompt submission.
      if (mode === "complete") {
        for (const current of state.histories.values()) {
          if (current.mode === "prolonged") current.mode = "complete";
        }
      }
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function tokenAndDigest() {
  const token = randomBytes(32).toString("hex");
  return { token, digest: createHash("sha256").update(token).digest("hex") };
}

function passwordHash(password) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scrypt(
      password,
      salt,
      64,
      { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derived) => {
        if (error) reject(error);
        else resolve([
          "scrypt",
          "v1",
          16_384,
          8,
          1,
          salt.toString("base64url"),
          derived.toString("base64url"),
        ].join("$"));
      },
    );
  });
}

async function createAccount(label) {
  const suffix = runId.replaceAll("-", "").slice(0, 16);
  const userId = `durable-character-${suffix}-${label.toLowerCase()}`;
  const email = `${label.toLowerCase()}.${suffix}@durable-character.test`;
  const password = `Durable character ${suffix} ${label} password!`;
  const { token, digest } = tokenAndDigest();
  await pool.query(
    `INSERT INTO obtv_users (id,email,password_hash,display_name,site_role)
     VALUES ($1,$2,$3,$4,'USER')`,
    [userId, email, await passwordHash(password), `Durable Character ${label}`],
  );
  const tenantId = randomUUID();
  await pool.query(
    `INSERT INTO obtv_tenants (id,name,slug,created_by_user_id)
     VALUES ($1,$2,$3,$4)`,
    [tenantId, `Durable Character ${label} ${runId.slice(0, 8)}`, `durable-character-${label.toLowerCase()}-${runId}`, userId],
  );
  await pool.query(
    "INSERT INTO obtv_tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'OWNER')",
    [tenantId, userId],
  );
  await pool.query("UPDATE obtv_users SET active_tenant_id=$1 WHERE id=$2", [tenantId, userId]);
  await pool.query(
    "INSERT INTO obtv_auth_sessions (id,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '2 hours')",
    [digest, userId],
  );
  const account = {
    label,
    userId,
    tenantId,
    email,
    password,
    token,
    browserContext: null,
    browserPage: null,
  };
  fixtures.push(account);
  return account;
}

async function insertMockWorker() {
  const workerId = randomUUID();
  workerIds.push(workerId);
  await pool.query(
    `INSERT INTO obtv_comfy_servers
       (id,display_name,hostname,api_base_url,websocket_url,gpu_name,vram_gb,tags,
        enabled,priority,max_concurrent_jobs,status,queue_size,active_job_count)
     VALUES ($1,$2,$3,$4,$5,'Mocked GPU worker',1.0,$6,true,-1000000,1,'ONLINE',-1000000,0)`,
    [
      workerId,
      `Durable character test worker ${runId}`,
      fakeWorker.apiBaseUrl.replace(/^https?:\/\//, "").split(":")[0],
      fakeWorker.apiBaseUrl,
      fakeWorker.websocketUrl,
      ["flux2-klein"],
    ],
  );
  return workerId;
}

async function api(account, requestPath, options = {}) {
  const headers = {
    origin,
    ...(options.body !== undefined && !options.headers?.["content-type"] && !options.headers?.["Content-Type"]
      ? { "content-type": "application/json" }
      : {}),
    ...(account.token ? { cookie: `obtv_session=${account.token}` } : {}),
    ...options.headers,
  };
  const response = await fetch(`${origin}/api${requestPath}`, { ...options, headers });
  const text = response.status === 204 ? "" : await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

function bodyError(response) {
  if (typeof response.body === "string") return response.body;
  return response.body?.error ?? JSON.stringify(response.body);
}

function assertStatus(response, expected, context) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert(statuses.includes(response.status), `${context}: expected ${statuses.join("/")}, got ${response.status}: ${bodyError(response)}`);
}

function jobFromResponse(response) {
  return response.body?.job ?? response.body?.generation ?? response.body;
}

function jobIdFromResponse(response) {
  const job = jobFromResponse(response);
  assert(job?.id, `Durable enqueue response did not contain a job id: ${bodyError(response)}`);
  return job.id;
}

function jobStatus(job) {
  return job?.status ?? job?.state;
}

function jobAssets(job) {
  if (Array.isArray(job?.assets)) return job.assets;
  if (job?.assetId || job?.mediaUrl) return [job];
  return [];
}

function findWorkflowNode(workflow, classType) {
  return Object.entries(workflow ?? {}).find(([, node]) => node?.class_type === classType);
}

function assertNativeCharacterWorkflow(workflow, upload, expectedPromptPattern) {
  const [loadId, load] = findWorkflowNode(workflow, "LoadImage") ?? [];
  const [scaleId, scale] = findWorkflowNode(workflow, "ImageScaleToTotalPixels") ?? [];
  const [encodeId, encode] = findWorkflowNode(workflow, "VAEEncode") ?? [];
  const references = Object.entries(workflow).filter(([, node]) => node?.class_type === "ReferenceLatent");
  const [emptyId, empty] = findWorkflowNode(workflow, "EmptyFlux2LatentImage") ?? [];
  const [schedulerId, scheduler] = findWorkflowNode(workflow, "Flux2Scheduler") ?? [];
  const [clipId, clip] = findWorkflowNode(workflow, "CLIPTextEncode") ?? [];
  const [zeroId, zero] = findWorkflowNode(workflow, "ConditioningZeroOut") ?? [];
  const [guiderId, guider] = findWorkflowNode(workflow, "CFGGuider") ?? [];
  const [samplerId, sampler] = findWorkflowNode(workflow, "SamplerCustomAdvanced") ?? [];
  const [vaeId] = findWorkflowNode(workflow, "VAELoader") ?? [];
  const [unetId] = findWorkflowNode(workflow, "UNETLoader") ?? [];
  assert(
    load && scale && encode && references.length === 2 && empty && scheduler && clip && zero && guider && sampler,
    "Native character generation must use the complete FLUX.2 Klein edit graph",
  );
  assert.deepEqual(upload.fileBytes, tinyPng, "Native source upload must preserve source bytes exactly");
  const sourceDimensions = pngDimensions(upload.fileBytes);
  assert(sourceDimensions, "Native source upload must remain a valid PNG");
  assert.notEqual(
    sourceDimensions.width / sourceDimensions.height,
    768 / 1024,
    "The fixture source aspect must differ from the requested target canvas",
  );
  assert.equal(load.inputs.image, upload.name, "LoadImage must consume the exact source upload");
  assert.deepEqual(scale.inputs, {
    image: [loadId, 0],
    upscale_method: "nearest-exact",
    megapixels: 1,
    resolution_steps: 1,
  });
  assert(
    !("width" in scale.inputs) && !("height" in scale.inputs) && !("crop" in scale.inputs),
    "ImageScaleToTotalPixels must preserve source aspect independently of target dimensions",
  );
  assert.deepEqual(encode.inputs.pixels, [scaleId, 0], "VAEEncode must consume the aspect-preserving source resize");
  assert.deepEqual(encode.inputs.vae, [vaeId, 0]);
  assert.deepEqual(references[0][1].inputs, {
    conditioning: [clipId, 0],
    latent: [encodeId, 0],
  });
  assert.deepEqual(references[1][1].inputs, {
    conditioning: [zeroId, 0],
    latent: [encodeId, 0],
  });
  assert.deepEqual(guider.inputs, {
    model: [unetId, 0],
    positive: [references[0][0], 0],
    negative: [references[1][0], 0],
    cfg: 1,
  });
  assert.deepEqual(empty.inputs, { width: 768, height: 1024, batch_size: 1 });
  assert.deepEqual(scheduler.inputs, { steps: 4, width: 768, height: 1024 });
  assert.deepEqual(sampler.inputs.sigmas, [schedulerId, 0]);
  assert.deepEqual(sampler.inputs.latent_image, [emptyId, 0]);
  assert(!("denoise" in sampler.inputs), "Native graph must not pass a denoise parameter");
  assert.equal(workflow[samplerId]?.class_type, "SamplerCustomAdvanced");
  assert.equal(Object.values(workflow).some((node) => node?.class_type === "ImageScale"), false);
  assert.equal(Object.values(workflow).some((node) => node?.class_type === "SplitSigmas"), false);
  assert.equal(Object.values(workflow).some((node) => node?.class_type === "RepeatLatentBatch"), false);
  const promptText = String(clip.inputs.text ?? "");
  assert.match(promptText, expectedPromptPattern);
  assert.match(promptText, /same person as that original/i);
  assert.match(promptText, /preserve the original person's face, hair, skin tone, and wardrobe/i);
  assert.doesNotMatch(promptText, /front-facing|facing camera/i);
  assert.equal(guiderId, "13");
}

async function loginThroughPreview(account) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${origin}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("input-sign-in-email").fill(account.email);
  await page.getByTestId("input-sign-in-password").fill(account.password);
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/auth/login",
    { timeout: 15_000 },
  );
  await page.getByTestId("button-sign-in-submit").click();
  assert.equal((await responsePromise).status(), 204, `Preview login failed for ${account.label}`);
  await page.waitForURL(/\/(?:studio|characters|generate|projects)/u, { timeout: 15_000 });
  assert(
    (await context.cookies(origin)).some((cookie) => cookie.name === "obtv_session"),
    `Preview login did not set a session for ${account.label}`,
  );
  account.browserContext = context;
  account.browserPage = page;
  return page;
}

async function createCharacter(account, name = `Durable ${account.label} ${runId.slice(0, 8)}`) {
  const response = await api(account, "/characters", {
    method: "POST",
    body: json({ name, description: "Durable generation fixture.", promptDescription: "A presenter in a copper scarf." }),
  });
  assertStatus(response, 201, `${account.label} character creation`);
  const character = response.body?.character ?? response.body;
  assert(character?.id, "Character creation did not return an ID");
  characterIds.push(character.id);
  return character;
}

async function uploadCharacterReference(account, characterId, label = "headshot") {
  const response = await api(account, `/characters/${characterId}/assets`, {
    method: "POST",
    body: tinyPng,
    headers: {
      "content-type": "image/png",
      "x-file-name": `durable-native-source-${runId}.png`,
      "x-asset-label": label,
    },
  });
  assertStatus(response, 201, "Native character source upload");
  const asset = response.body?.asset ?? response.body;
  assert(asset?.id, "Native character source upload must return an asset ID");
  return asset;
}

async function setApprovedDossier(account, characterId) {
  // Approval is seeded through the authenticated API's normal compare-and-
  // swap contract, while references are added directly only to keep this
  // lifecycle test independent from the dossier upload UI. The generated
  // asset must still invalidate this approved snapshot exactly once.
  const current = await api(account, `/characters/${characterId}/dossier`);
  assertStatus(current, 200, "Read fixture dossier");
  const dossier = current.body?.dossier ?? current.body;
  const revision = Math.max(3, Number(dossier.revision ?? 0));
  await pool.query(
    `UPDATE obtv_characters
        SET dossier_status='APPROVED', dossier_approved_at=NOW(), dossier_revision=$2
      WHERE id=$1 AND tenant_id=$3`,
    [characterId, revision, account.tenantId],
  );
  return revision;
}

function characterGeneratePath(characterId) {
  return `/characters/${characterId}/generate-image`;
}

async function enqueue(account, characterId, requestKey, prompt = "A durable copper-scarf presenter") {
  const started = performance.now();
  const response = await api(account, characterGeneratePath(characterId), {
    method: "POST",
    body: json({
      prompt,
      seed: 42,
      referenceLabel: "profile",
      requestKey,
    }),
  });
  const elapsed = performance.now() - started;
  assert(elapsed < 2_000, `Character enqueue took ${Math.round(elapsed)}ms; it must acknowledge before worker completion`);
  assertStatus(response, 202, "Character durable enqueue");
  const jobId = jobIdFromResponse(response);
  const job = jobFromResponse(response);
  assert(["QUEUED", "RUNNING"].includes(jobStatus(job)), `New character job must be active, got ${jobStatus(job)}`);
  return { response, job, jobId, elapsed };
}

async function findJob(account, jobId, characterId) {
  const response = await api(account, `/characters/${characterId}/dossier`);
  assertStatus(response, 200, `Read durable character job ${jobId} through dossier`);
  const dossier = response.body?.dossier ?? response.body;
  const job = dossier?.imageGeneration;
  assert(job, `Dossier did not expose imageGeneration for job ${jobId}`);
  assert.equal(job.id, jobId, "Dossier returned a different latest character image job");
  return job;
}

async function waitForJob(account, jobId, characterId, expected = ["COMPLETED"], timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let job;
  while (Date.now() < deadline) {
    job = await findJob(account, jobId, characterId);
    if (expected.includes(jobStatus(job))) return job;
    if (["FAILED", "CANCELLED"].includes(jobStatus(job)) && !expected.includes(jobStatus(job))) {
      throw new Error(`Job ${jobId} became ${jobStatus(job)}: ${job.errorMessage ?? "no error message"}`);
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${jobId}; last status=${jobStatus(job)}`);
}

async function countCharacterAssets(account, characterId, label = "profile") {
  const dossierResponse = await api(account, `/characters/${characterId}/dossier`);
  assertStatus(dossierResponse, 200, "Read dossier after generation");
  const dossier = dossierResponse.body?.dossier ?? dossierResponse.body;
  return {
    dossier,
    assets: (dossier.assets ?? []).filter((asset) => asset.label === label),
  };
}

async function testEnqueueDedupAndCompletion(owner, foreign, character) {
  const approvedRevision = await setApprovedDossier(owner, character.id);
  // Hold the first worker history open long enough to exercise both idempotent
  // reuse and the distinct-request conflict while the job is active.
  fakeWorker.setMode("prolonged");
  const requestKey = randomUUID();
  const first = await enqueue(owner, character.id, requestKey);
  // The first response is already durable before the worker can finish. A
  // repeated request key must resolve to that existing record, not create or
  // submit another task.
  const duplicate = await enqueue(owner, character.id, requestKey);
  assert.equal(first.jobId, duplicate.jobId, "Duplicate active requests must return the same durable job");
  assert.equal(duplicate.job.status, first.job.status, "Idempotent duplicate must return the existing lifecycle state");
  const differentRequest = await api(owner, characterGeneratePath(character.id), {
    method: "POST",
    body: json({
      prompt: "A different active request must be rejected",
      seed: 43,
      referenceLabel: "profile",
      requestKey: randomUUID(),
    }),
  });
  assertStatus(differentRequest, 409, "Distinct active character generation request");
  fakeWorker.setMode("complete");
  await waitForJob(owner, first.jobId, character.id);
  await sleep(500);
  assert.equal(fakeWorker.state.submissions, 1, "Duplicate active requests must submit to the worker once");
  const completed = await findJob(owner, first.jobId, character.id);
  assert.equal(jobStatus(completed), "COMPLETED");
  assert(completed.mediaUrl, "Completed job must expose the persisted output media URL");
  assert(completed.assetId, "Completed job must expose the attached character asset ID");
  assert.equal(jobAssets(completed).length, 1, "Completed job must expose exactly one output");
  const firstAssets = await countCharacterAssets(owner, character.id);
  assert.equal(firstAssets.assets.length, 1, "Completion must attach exactly one labeled character asset");
  assert.equal(firstAssets.assets[0].label, "profile");
  assert.equal(firstAssets.dossier.status, "DRAFT", "Completion must invalidate an approved dossier");
  assert.equal(firstAssets.dossier.approvedAt ?? null, null, "Completion must clear dossier approval time");
  assert.equal(
    firstAssets.dossier.revision,
    approvedRevision + 1,
    "Completion must invalidate the approved dossier exactly once",
  );
  const afterRevision = firstAssets.dossier.revision;
  const repeated = await findJob(owner, first.jobId, character.id);
  assert.equal(jobAssets(repeated).length, 1, "Reading a completed job must not attach another asset");
  const secondAssets = await countCharacterAssets(owner, character.id);
  assert.equal(secondAssets.assets.length, 1, "Repeated completion polling must remain idempotent");
  assert.equal(secondAssets.dossier.revision, afterRevision);
  const foreignRead = await findJob(foreign, first.jobId, character.id).catch((error) => error);
  assert(
    foreignRead instanceof Error || foreignRead === null,
    "Foreign tenant must not receive the owner's durable job",
  );
}

async function testNativeCharacterReferenceContract(owner, character) {
  const source = await uploadCharacterReference(owner, character.id);
  fakeWorker.setMode("complete");
  const profileResponse = await api(owner, characterGeneratePath(character.id), {
    method: "POST",
    body: json({
      prompt: "A requested profile continuity view",
      seed: 71,
      referenceLabel: "profile",
      referenceAssetId: source.id,
      requestKey: randomUUID(),
    }),
  });
  assertStatus(profileResponse, 202, "Native profile character enqueue");
  const profileJobId = jobIdFromResponse(profileResponse);
  await waitForJob(owner, profileJobId, character.id);
  const profileWorkflow = fakeWorker.state.workflows.at(-1)?.workflow;
  assert(profileWorkflow, "Fixture worker must capture the native profile workflow");
  const profileUpload = fakeWorker.state.uploads.at(-1);
  assert(profileUpload, "Native profile generation must upload its source");
  assertNativeCharacterWorkflow(profileWorkflow, profileUpload, /full 90-degree side profile; exactly one eye visible/i);

  const threeQuarterResponse = await api(owner, characterGeneratePath(character.id), {
    method: "POST",
    body: json({
      prompt: "A requested three-quarter continuity view",
      seed: 72,
      referenceLabel: "three-quarter",
      referenceAssetId: source.id,
      requestKey: randomUUID(),
    }),
  });
  assertStatus(threeQuarterResponse, 202, "Native three-quarter character enqueue");
  const threeQuarterJobId = jobIdFromResponse(threeQuarterResponse);
  await waitForJob(owner, threeQuarterJobId, character.id);
  const threeQuarterWorkflow = fakeWorker.state.workflows.at(-1)?.workflow;
  assert(threeQuarterWorkflow, "Fixture worker must capture the native three-quarter workflow");
  const threeQuarterUpload = fakeWorker.state.uploads.at(-1);
  assert(threeQuarterUpload, "Native three-quarter generation must upload its source");
  assertNativeCharacterWorkflow(
    threeQuarterWorkflow,
    threeQuarterUpload,
    /45-degree three-quarter view/i,
  );
  assert(
    fakeWorker.state.uploads.every((upload) => upload.fileBytes?.equals(tinyPng)),
    "Every native source upload must preserve the original bytes",
  );

}

async function testProlongedJobRemainsActive(owner) {
  // This case deliberately rewrites created_at to simulate a long-running
  // render. Keep it on a fresh character so the dossier's latest-job query
  // cannot legitimately prefer a newer job whose timestamp was not rewritten.
  const character = await createCharacter(
    owner,
    `Durable prolonged ${runId.slice(0, 8)}`,
  );
  fakeWorker.setMode("prolonged");
  const requestKey = randomUUID();
  const created = await enqueue(owner, character.id, requestKey, "A deliberately prolonged mocked render");
  // Move the persisted timestamps beyond the five-minute monitor budget. This
  // avoids making a regression run sleep five real minutes while still proving
  // that the durable monitor does not turn an active worker task into a
  // terminal failure at that boundary.
  await pool.query(
    `UPDATE obtv_image_studio_jobs
        SET created_at=NOW()-INTERVAL '6 minutes',
            started_at=NOW()-INTERVAL '6 minutes'
      WHERE id=$1`,
    [created.jobId],
  );
  await sleep(2_500);
  const job = await findJob(owner, created.jobId, character.id);
  assert(["QUEUED", "RUNNING"].includes(jobStatus(job)), `A worker task older than five minutes must remain active, got ${jobStatus(job)}`);
  // Leave the shared mocked worker slot available for the following recovery
  // cases. This changes only this run's durable fixture row, never a live
  // worker or a production job.
  await pool.query(
    "UPDATE obtv_image_studio_jobs SET status='FAILED', error_message='test cleanup' WHERE id=$1",
    [created.jobId],
  );
}

async function testTransientRecovery(owner, character) {
  fakeWorker.setMode("transient");
  const requestKey = randomUUID();
  const before = fakeWorker.state.submissions;
  const created = await enqueue(owner, character.id, requestKey, "A transiently disconnected render");
  const completed = await waitForJob(owner, created.jobId, character.id);
  assert.equal(jobStatus(completed), "COMPLETED");
  assert.equal(fakeWorker.state.submissions, before + 1, "Transient polling recovery must not resubmit the accepted worker task");
}

async function testAppRestartRecovery(owner, character) {
  const restartHook = process.env.DURABLE_CHARACTER_RESTART_HOOK;
  if (!restartHook) {
    return "skipped (set DURABLE_CHARACTER_RESTART_HOOK to the development restart fixture)";
  }
  fakeWorker.setMode("prolonged");
  const baselineSubmissions = fakeWorker.state.submissions;
  const created = await enqueue(
    owner,
    character.id,
    randomUUID(),
    "A persisted job that must survive an application restart",
  );
  const submissionDeadline = Date.now() + 10_000;
  while (fakeWorker.state.submissions < baselineSubmissions + 1 && Date.now() < submissionDeadline) await sleep(100);
  assert.equal(
    fakeWorker.state.submissions,
    baselineSubmissions + 1,
    "Restart fixture must record exactly one initial worker submission",
  );
  const persisted = await pool.query(
    `SELECT provider_request_id, status
       FROM obtv_image_studio_jobs
      WHERE id=$1 AND tenant_id=$2`,
    [created.jobId, owner.tenantId],
  );
  assert.equal(persisted.rows.length, 1, "Restart fixture job must be persisted in the owner tenant");
  assert(persisted.rows[0].provider_request_id, "Restart fixture must persist the accepted worker prompt id");
  assert(["QUEUED", "RUNNING"].includes(persisted.rows[0].status));

  // The test runner owns the development workflow restart. The hook is
  // intentionally external so this script never restarts Maya or a live
  // server itself. A hook should return only after the API process has
  // restarted and called its durable-job reconciliation.
  const hookResponse = await fetch(restartHook, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: json({ jobId: created.jobId }),
  });
  assert(hookResponse.ok, `Application restart hook failed with HTTP ${hookResponse.status}`);
  fakeWorker.setMode("complete");
  const completed = await waitForJob(owner, created.jobId, character.id);
  assert.equal(jobStatus(completed), "COMPLETED", "A persisted accepted job must resume after app restart");
  assert.equal(
    fakeWorker.state.submissions,
    baselineSubmissions + 1,
    "Restart recovery must poll the persisted prompt rather than submitting a duplicate",
  );
  return "verified";
}

async function testTenantIsolation(foreign, owner, character) {
  const ownerJobs = await api(owner, `/image-studio/jobs?limit=100`);
  const foreignJobs = await api(foreign, `/image-studio/jobs?limit=100`);
  if (ownerJobs.status === 200 && foreignJobs.status === 200) {
    assert(
      !(foreignJobs.body?.jobs ?? []).some((job) => characterIds.includes(job.characterId)),
      "Foreign job listing must not include the owner's character jobs",
    );
  }
  const ownerOnly = await api(owner, `/characters/${character.id}/dossier`);
  assertStatus(ownerOnly, 200, "Owner dossier read");
  const foreignDossier = await api(foreign, `/characters/${character.id}/dossier`);
  assert([403, 404].includes(foreignDossier.status), "Foreign tenant must not read the owner's dossier");
  const foreignEnqueue = await api(foreign, characterGeneratePath(character.id), {
    method: "POST",
    body: json({ prompt: "Cross-tenant attempt", referenceLabel: "profile", requestKey: randomUUID() }),
  });
  assert([403, 404].includes(foreignEnqueue.status), "Foreign tenant must not enqueue for the owner's character");
}

async function openCharacterReferences(page, characterName) {
  await page.goto(`${origin}/characters`, { waitUntil: "domcontentloaded" });
  await page.getByText(characterName, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  const cardText = page.getByText(characterName, { exact: true }).first();
  const card = cardText.locator("xpath=ancestor::*[.//button][1]");
  const edit = card.getByRole("button", { name: new RegExp(`^Edit\\s+${characterName}$`, "i") });
  if (await edit.count()) await edit.click();
  else await cardText.click();
  const dialog = page.getByRole("dialog").last();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const tab = dialog.getByRole("tab", { name: /Visual References|References/i });
  if (await tab.count()) await tab.click();
  else await dialog.getByText(/Visual References|References/i).last().click();
  await dialog.getByText(/Generate a reference image/i).waitFor({ state: "visible", timeout: 10_000 });
  return dialog;
}

function assertNoRawHtml(text, context) {
  assert(!/<\/?(?:html|head|body|title|script|style)\b/i.test(text), `${context} exposed raw HTML`);
}

async function testAuthenticatedUi(owner, character) {
  const page = owner.browserPage;
  const dialog = await openCharacterReferences(page, character.name);
  const prompt = dialog.getByPlaceholder("Describe the reference image...");
  await prompt.fill("A browser-progress durable reference");
  fakeWorker.setMode("prolonged");
  const enqueueResponse = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/characters/${character.id}/generate-image`,
    { timeout: 10_000 },
  );
  await dialog.getByRole("button", { name: /Generate image/i }).click();
  const enqueueResult = await enqueueResponse;
  assert.equal(enqueueResult.status(), 202, "UI generation must receive a durable enqueue response");
  const enqueueBody = await enqueueResult.json().catch(() => ({}));
  const uiJobId = enqueueBody?.job?.id ?? enqueueBody?.id;
  assert(uiJobId, "UI durable enqueue response must expose a job id");
  await page.getByRole("button", { name: /Close|Cancel/i }).last().click().catch(() => undefined);
  await page.waitForTimeout(200);
  await openCharacterReferences(page, character.name);
  const reopenedText = await page.getByRole("dialog").last().innerText();
  assert(/queued|running|generat|progress/i.test(reopenedText), "Progress must survive closing and reopening the dossier");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openCharacterReferences(page, character.name);
  const reloadedText = await page.getByRole("dialog").last().innerText();
  assert(/queued|running|generat|progress/i.test(reloadedText), "Progress must survive a browser reload");
  assertNoRawHtml(reloadedText, "Reloaded progress UI");
  const progressScreenshot = `${screenshotRoot}/durable-character-${runId}-progress.png`;
  await page.screenshot({ path: progressScreenshot, fullPage: true });
  stageLog(`UI progress screenshot: ${progressScreenshot}`);

  // Complete this reload fixture through the mocked worker rather than
  // force-failing its row. That releases the character's active-job guard for
  // the following failure and gallery cases and verifies the normal terminal
  // path after a browser reconnect.
  fakeWorker.setMode("complete");
  const completed = await waitForJob(owner, uiJobId, character.id);
  assert.equal(jobStatus(completed), "COMPLETED", "Reload continuity fixture must complete normally");
}

async function testUiFailureMessage(owner, character) {
  const page = owner.browserPage;
  const dialog = await openCharacterReferences(page, character.name);
  fakeWorker.setMode("failure");
  await dialog.getByPlaceholder("Describe the reference image...").fill("A friendly failure fixture");
  const enqueueResponse = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/characters/${character.id}/generate-image`,
    { timeout: 10_000 },
  );
  await dialog.getByRole("button", { name: /Generate image/i }).click();
  const response = await enqueueResponse;
  assert.equal(response.status(), 202, "UI failure request must be accepted as a durable job");
  const body = await response.json().catch(() => ({}));
  const jobId = body?.job?.id ?? body?.id;
  assert(jobId, "UI failure response must expose a durable job id");
  const failed = await waitForJob(owner, jobId, character.id, ["FAILED"], 30_000);
  assert.equal(jobStatus(failed), "FAILED", "Mocked worker failure must reach the durable FAILED state");
  const statusPanel = page.getByTestId(`status-character-image-generation-${character.id}`);
  await statusPanel.getByText(/Error/i).waitFor({ state: "visible", timeout: 20_000 });
  const text = await page.locator("body").innerText();
  assertNoRawHtml(text, "Friendly generation error");
  assert(!/execution_error|mock worker error/i.test(text), "UI must show a friendly error rather than raw worker details");
}

async function testUiCompletionGallery(owner, character) {
  const page = owner.browserPage;
  const before = await countCharacterAssets(owner, character.id, "headshot");
  const dialog = await openCharacterReferences(page, character.name);
  fakeWorker.setMode("complete");
  await dialog.getByPlaceholder("Describe the reference image...").fill("A completed gallery fixture");
  const enqueueResponse = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/characters/${character.id}/generate-image`,
    { timeout: 10_000 },
  );
  await dialog.getByRole("button", { name: /Generate image/i }).click();
  const response = await enqueueResponse;
  assert.equal(response.status(), 202, "UI completion request must be accepted as a durable job");
  const body = await response.json().catch(() => ({}));
  const jobId = body?.job?.id ?? body?.id;
  assert(jobId, "UI completion response must expose a durable job id");
  await waitForJob(owner, jobId, character.id);
  const after = await countCharacterAssets(owner, character.id, "headshot");
  assert.equal(after.assets.length, before.assets.length + 1, "Completed UI job must add exactly one gallery asset");
  await page.getByText(/image generated|completed|profile/i).last().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloaded = await openCharacterReferences(page, character.name);
  const galleryImage = reloaded.locator('img[src*="/api/media/"]').first();
  await galleryImage.waitFor({ state: "visible", timeout: 15_000 });
  const src = await galleryImage.getAttribute("src");
  assert(src && src.includes("/api/media/"), "Completed gallery must expose the attached media URL");
  const galleryScreenshot = `${screenshotRoot}/durable-character-${runId}-completed-gallery.png`;
  await page.screenshot({ path: galleryScreenshot, fullPage: true });
  stageLog(`UI completed gallery screenshot: ${galleryScreenshot}`);
  assertNoRawHtml(await page.locator("body").innerText(), "Completed gallery UI");
}

async function cleanupAccount(account) {
  try {
    for (const id of characterIds) {
      await api(account, `/characters/${id}`, { method: "DELETE" }).catch(() => undefined);
    }
    await pool.query("DELETE FROM obtv_image_studio_assets WHERE tenant_id=$1", [account.tenantId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_image_studio_jobs WHERE tenant_id=$1", [account.tenantId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_generation_jobs WHERE tenant_id=$1", [account.tenantId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_tenant_memberships WHERE tenant_id=$1", [account.tenantId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_auth_sessions WHERE user_id=$1", [account.userId]).catch(() => undefined);
    await pool.query("UPDATE obtv_users SET active_tenant_id=NULL WHERE id=$1", [account.userId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_tenants WHERE id=$1", [account.tenantId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_users WHERE id=$1", [account.userId]).catch(() => undefined);
  } catch (error) {
    console.error(`Durable character fixture cleanup failed (${account.label}, run ${runId}): ${safeError(error)}`);
  }
}

try {
  if (uiOnly) {
    stageLog("UI-only mode enabled; API lifecycle and restart stages will be skipped");
  }
  fakeWorker = await runStage("start mocked Comfy worker", startMockWorker);
  await runStage("register mocked worker", insertMockWorker);
  const owner = await runStage("create owner fixture", () => createAccount("Owner"));
  const foreign = uiOnly
    ? null
    : await runStage("create foreign fixture", () => createAccount("Foreign"));
  browser = await runStage(
    "launch browser",
    () => chromium.launch({ headless: true, executablePath: chromiumPath, args: ["--no-sandbox"] }),
  );
  await runStage("authenticate owner browser", () => loginThroughPreview(owner));
  if (foreign) await runStage("authenticate foreign browser", () => loginThroughPreview(foreign));
  const character = await runStage("create primary character", () => createCharacter(owner));
  let restartResult = "skipped in UI-only mode";
  if (!uiOnly) {
    await runStage(
      "enqueue deduplication and completion",
      () => testEnqueueDedupAndCompletion(owner, foreign, character),
    );
    await runStage(
      "retain prolonged render beyond five minutes",
      () => testProlongedJobRemainsActive(owner),
    );
    await runStage("recover transient worker failure", () => testTransientRecovery(owner, character));
    restartResult = await runStage(
      "recover persisted job after application restart",
      () => testAppRestartRecovery(owner, character),
    );
    await runStage("enforce tenant isolation", () => testTenantIsolation(foreign, owner, character));
    await runStage(
      "verify native character reference edit contract",
      () => testNativeCharacterReferenceContract(owner, character),
    );
  }
  await runStage("verify authenticated UI reload continuity", () => testAuthenticatedUi(owner, character));
  await runStage("verify friendly UI failure", () => testUiFailureMessage(owner, character));
  await runStage("verify UI completion gallery", () => testUiCompletionGallery(owner, character));
  console.log(
    `PASS: durable character enqueue under 2s, duplicate suppression, exactly-once labeled attachment and dossier invalidation, native source-conditioned profile/three-quarter edit graph, exact source upload and aspect-preserving resize, prolonged-job retention, transient recovery, app-restart recovery ${restartResult}, tenant isolation, authenticated UI reload continuity, friendly errors, and gallery completion`,
  );
} catch (error) {
  process.exitCode = 1;
  console.error(`FAIL durable character generation: ${safeError(error)}`);
} finally {
  await browser?.close().catch(() => undefined);
  for (const account of fixtures) await cleanupAccount(account);
  if (workerIds.length) {
    await pool.query("DELETE FROM obtv_comfy_servers WHERE id=ANY($1::uuid[])", [workerIds]).catch(() => undefined);
  }
  await fakeWorker?.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
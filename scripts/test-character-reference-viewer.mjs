#!/usr/bin/env node
// Focused character-reference regression harness. It exercises only isolated
// fixture tenants and a local mocked Comfy worker:
//
//   CHARACTER_REFERENCE_TEST=1 node scripts/test-character-reference-viewer.mjs
//
// The worker accepts HTTP requests but never performs inference. This test is
// intentionally separate from the durable-generation lifecycle harness so a
// reference-viewer regression can be run without touching a real render.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, scrypt } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { chromium } from "@playwright/test";

if (process.env.NODE_ENV === "production") throw new Error("Development test only");
const orderOnly = process.env.CHARACTER_ORDER_TEST === "1";
if (process.env.CHARACTER_REFERENCE_TEST !== "1" && !orderOnly) {
  throw new Error(
    "Refusing to run without CHARACTER_REFERENCE_TEST=1 or CHARACTER_ORDER_TEST=1; this harness creates isolated fixture tenants.",
  );
}
if (!process.env.REPLIT_DEV_DOMAIN) throw new Error("REPLIT_DEV_DOMAIN is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const { WebSocketServer } = require("ws");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/repl/tools/bin/chromium";
const runId = randomUUID();
const fixtures = [];
const workerIds = [];
let browser;
let fakeWorker;

const originalPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mNkYGD4z8DAwMDAwMDAAAwBAAEGAPr9C8cAAAAASUVORK5CYII=",
  "base64",
);
const alternatePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==",
  "base64",
);
const generatedPng = alternatePng;
const WARDROBE_PROMPT = "Full-length outfit reference of this character wearing the outfit shown in the source image, head to toe with shoes visible. Keep the original background; do not add a closet, clothing rack, hangers, or extra garments.";

const REQUIRED_OBJECT_INFO = {
  UNETLoader: { input: { required: { unet_name: [["flux-2-klein-4b.safetensors"]] } } },
  CLIPLoader: { input: { required: { clip_name: [["qwen_3_4b.safetensors"]] } } },
  VAELoader: { input: { required: { vae_name: [["flux2-vae.safetensors"]] } } },
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
  // Native FLUX.2 Klein reference editing is capability-gated on the
  // schemas below. Keep these fields populated: an empty object would make
  // this fixture claim support without exercising the resize contract.
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
  VAEEncode: {},
  ReferenceLatent: {
    input: {
      required: { conditioning: ["CONDITIONING"] },
      optional: { latent: ["LATENT"] },
    },
  },
  RepeatLatentBatch: {},
  SplitSigmas: {},
  VAEDecode: {},
  SaveImage: {},
};

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stageLog(message) {
  console.log(`[character-reference ${runId.slice(0, 8)}] ${message}`);
}

function json(value) {
  return JSON.stringify(value);
}

function safeError(error) {
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  return detail
    .replace(/(?:postgres(?:ql)?):\/\/\S+/gi, "[database connection redacted]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[credentials-redacted]@")
    .replace(/obtv_session=[^;\s]+/gi, "obtv_session=[session redacted]");
}

function firstNonLoopbackAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
        return entry.address;
      }
    }
  }
  throw new Error("The mocked worker needs a non-loopback IPv4 address");
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
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
      outputs: { "1": { images: [{ filename, subfolder: "", type: "output" }] } },
    },
  };
}

function objectInfo() {
  // This harness shares the development database with every configured
  // worker. Missing-native-capability fail-closed behavior belongs in the
  // isolated adapter/selection unit tests, never a live POST that could scan
  // past this fixture and reserve another worker.
  return { ...REQUIRED_OBJECT_INFO };
}

function findWorkflowNode(workflow, classType) {
  return Object.entries(workflow ?? {}).find(([, node]) => node?.class_type === classType);
}

async function startMockWorker() {
  const state = {
    mode: "prolonged",
    submissions: 0,
    histories: new Map(),
    historyReads: new Map(),
    workflows: [],
    uploads: [],
    websocketClients: new Set(),
    websocketClientsById: new Map(),
    progressJobs: new Map(),
    progressEvents: 0,
    foreignProgressEvents: 0,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://worker.invalid");
    if (request.method === "GET" && url.pathname.startsWith("/object_info")) {
      sendJson(response, 200, objectInfo());
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/models/")) {
      const folder = url.pathname.slice("/models/".length);
      const models = folder === "unet"
        ? ["flux-2-klein-4b.safetensors"]
        : folder === "clip"
          ? ["qwen_3_4b.safetensors"]
          : ["flux2-vae.safetensors"];
      sendJson(response, 200, models);
      return;
    }
    if (request.method === "GET" && url.pathname === "/system_stats") {
      sendJson(response, 200, { system: { os: "test", runtime_version: "character-reference-fixture" } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/queue") {
      const active = [...state.histories.entries()]
        .filter(([, entry]) => entry.mode === "prolonged")
        .map(([id]) => [id, {}, id]);
      sendJson(response, 200, { queue_running: active, queue_pending: [] });
      return;
    }
    if (request.method === "POST" && url.pathname === "/upload/image") {
      const body = await readRequestBody(request);
      const name = `character-reference-${state.uploads.length + 1}.png`;
      const contentType = request.headers["content-type"] ?? "";
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
      const rawBody = await readRequestBody(request);
      const body = JSON.parse(rawBody.toString("utf8"));
      const promptId = `character-reference-prompt-${state.submissions + 1}`;
      state.submissions += 1;
      state.workflows.push({ promptId, workflow: body?.prompt ?? null, clientId: body?.client_id ?? null });
      state.histories.set(promptId, { mode: state.mode, workflow: body?.prompt ?? null });
      state.historyReads.set(promptId, 0);
      const progressJob = {
        promptId,
        clientId: typeof body?.client_id === "string" ? body.client_id : "",
        telemetryEnabled: false,
        matchingEventsSent: 0,
        foreignProgressSent: false,
        foreignProgressScheduled: false,
        matchingInterval: null,
        foreignTimer: null,
      };
      state.progressJobs.set(promptId, progressJob);
      sendJson(response, 200, { prompt_id: promptId });
      return;
    }
    if (request.method === "GET" && url.pathname === "/history") {
      sendJson(response, 200, Object.fromEntries(
        [...state.histories.keys()].map((id) => [id, { prompt: state.histories.get(id)?.workflow ?? null }]),
      ));
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
      if (current.mode === "prolonged") {
        sendJson(response, 200, {});
        return;
      }
      sendJson(response, 200, pngHistory(promptId, `${promptId}.png`));
      return;
    }
    if (request.method === "GET" && url.pathname === "/view") {
      response.writeHead(200, { "content-type": "image/png", "content-length": generatedPng.length });
      response.end(generatedPng);
      return;
    }
    if (request.method === "POST" && (url.pathname === "/queue" || url.pathname === "/interrupt")) {
      sendJson(response, 200, {});
      return;
    }
    sendJson(response, 404, { error: "character-reference fixture route not found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const websocketServer = new WebSocketServer({ server, path: "/ws" });
  websocketServer.on("connection", (socket, request) => {
    const requestUrl = new URL(request.url ?? "/ws", "http://worker.invalid");
    const clientId = requestUrl.searchParams.get("clientId");
    if (!clientId) {
      socket.close();
      return;
    }
    state.websocketClients.add(socket);
    const clients = state.websocketClientsById.get(clientId) ?? new Set();
    clients.add(socket);
    state.websocketClientsById.set(clientId, clients);
    const removeSocket = () => {
      state.websocketClients.delete(socket);
      clients.delete(socket);
      if (clients.size === 0) state.websocketClientsById.delete(clientId);
    };
    socket.once("close", removeSocket);
    socket.once("error", removeSocket);
  });
  const sendProgress = (progressJob, promptId) => {
    const clients = state.websocketClientsById.get(progressJob.clientId) ?? new Set();
    const message = JSON.stringify({
      type: "progress",
      data: { prompt_id: promptId, node: "16", value: 2, max: 4 },
    });
    let sent = false;
    for (const socket of clients) {
      if (socket.readyState !== 1) continue;
      socket.send(message);
      sent = true;
    }
    return sent;
  };
  const sendForeignProgress = (progressJob) => {
    const clients = state.websocketClientsById.get(progressJob.clientId) ?? new Set();
    const message = JSON.stringify({
      type: "progress",
      data: {
        prompt_id: `${progressJob.promptId}-foreign`,
        node: "11",
        value: 4,
        max: 4,
      },
    });
    let sent = false;
    for (const socket of clients) {
      if (socket.readyState !== 1) continue;
      socket.send(message);
      sent = true;
    }
    if (sent) {
      progressJob.foreignProgressSent = true;
      state.foreignProgressEvents += 1;
    }
    return sent;
  };
  const scheduleForeignProgress = (progressJob) => {
    if (progressJob.foreignProgressScheduled || progressJob.foreignProgressSent) return;
    progressJob.foreignProgressScheduled = true;
    const attempt = () => {
      progressJob.foreignTimer = null;
      if (!progressJob.telemetryEnabled || progressJob.foreignProgressSent) return;
      if (!sendForeignProgress(progressJob)) {
        progressJob.foreignTimer = setTimeout(attempt, 100);
        progressJob.foreignTimer.unref?.();
      }
    };
    progressJob.foreignTimer = setTimeout(attempt, 75);
    progressJob.foreignTimer.unref?.();
  };
  const emitMatchingProgress = (progressJob, scheduleForeign = true) => {
    if (!progressJob.telemetryEnabled) return;
    if (!sendProgress(progressJob, progressJob.promptId)) return;
    progressJob.matchingEventsSent += 1;
    state.progressEvents += 1;
    if (scheduleForeign && progressJob.matchingEventsSent >= 2) {
      if (progressJob.matchingInterval) clearInterval(progressJob.matchingInterval);
      progressJob.matchingInterval = null;
      scheduleForeignProgress(progressJob);
    }
  };
  const beginProgressTelemetry = (resume = false) => {
    for (const progressJob of state.progressJobs.values()) {
      progressJob.telemetryEnabled = true;
      if (progressJob.matchingInterval) continue;
      const scheduleForeign = !resume && !progressJob.foreignProgressScheduled;
      progressJob.matchingInterval = setInterval(
        () => emitMatchingProgress(progressJob, scheduleForeign),
        250,
      );
      progressJob.matchingInterval.unref?.();
      emitMatchingProgress(progressJob, scheduleForeign);
    }
  };
  const address = server.address();
  assert(address && typeof address === "object" && address.port, "Mock worker did not bind a port");
  const host = process.env.CHARACTER_REFERENCE_FAKE_WORKER_HOST || firstNonLoopbackAddress();
  return {
    state,
    server,
    apiBaseUrl: `http://${host}:${address.port}`,
    websocketUrl: `ws://${host}:${address.port}/ws`,
    setMode(mode) {
      assert(["complete", "prolonged"].includes(mode));
      state.mode = mode;
      if (mode === "complete") {
        for (const entry of state.histories.values()) {
          if (entry.mode === "prolonged") entry.mode = "complete";
        }
      }
    },
    beginProgressTelemetry() {
      beginProgressTelemetry();
    },
    resumeProgressTelemetry() {
      beginProgressTelemetry(true);
    },
    async close() {
      for (const progressJob of state.progressJobs.values()) {
        if (progressJob.matchingInterval) clearInterval(progressJob.matchingInterval);
        if (progressJob.foreignTimer) clearTimeout(progressJob.foreignTimer);
        progressJob.matchingInterval = null;
        progressJob.foreignTimer = null;
      }
      for (const socket of state.websocketClients) socket.terminate();
      state.websocketClients.clear();
      state.websocketClientsById.clear();
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        websocketServer.close(finish);
        const timer = setTimeout(finish, 1_000);
        timer.unref?.();
      });
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        server.close(finish);
        const timer = setTimeout(() => {
          server.closeAllConnections?.();
          finish();
        }, 1_000);
        timer.unref?.();
      });
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
    scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error);
      else resolve(["scrypt", "v1", 16_384, 8, 1, salt.toString("base64url"), derived.toString("base64url")].join("$"));
    });
  });
}

async function createAccount(label) {
  const suffix = runId.replaceAll("-", "").slice(0, 16);
  const userId = `character-reference-${suffix}-${label.toLowerCase()}`;
  const email = `${label.toLowerCase()}.${suffix}@character-reference.test`;
  const password = `Character reference ${suffix} ${label} password!`;
  const { token, digest } = tokenAndDigest();
  const tenantId = randomUUID();
  await pool.query(
    "INSERT INTO obtv_users (id,email,password_hash,display_name,site_role) VALUES ($1,$2,$3,$4,'USER')",
    [userId, email, await passwordHash(password), `Character Reference ${label}`],
  );
  await pool.query(
    "INSERT INTO obtv_tenants (id,name,slug,created_by_user_id) VALUES ($1,$2,$3,$4)",
    [tenantId, `Character Reference ${label} ${runId.slice(0, 8)}`, `character-reference-${label.toLowerCase()}-${runId}`, userId],
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
    characterIds: [],
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
     VALUES ($1,$2,$3,$4,$5,'Character reference fixture GPU',1.0,$6,true,-1000000,1,'ONLINE',-1000000,0)`,
    [
      workerId,
      `Character reference fixture worker ${runId}`,
      fakeWorker.apiBaseUrl.replace(/^https?:\/\//, "").split(":")[0],
      fakeWorker.apiBaseUrl,
      fakeWorker.websocketUrl,
      ["flux2-klein"],
    ],
  );
  return workerId;
}

async function api(account, requestPath, options = {}) {
  const body = options.body;
  const binary = Buffer.isBuffer(body) || body instanceof Uint8Array || body instanceof ArrayBuffer;
  const headers = {
    origin,
    ...(body !== undefined && !binary && !options.headers?.["content-type"] && !options.headers?.["Content-Type"]
      ? { "content-type": "application/json" }
      : {}),
    ...(account.token ? { cookie: `obtv_session=${account.token}` } : {}),
    ...options.headers,
  };
  const response = await fetch(`${origin}/api${requestPath}`, { ...options, headers });
  const text = response.status === 204 ? "" : await response.text();
  let bodyValue = null;
  if (text) {
    try {
      bodyValue = JSON.parse(text);
    } catch {
      bodyValue = text;
    }
  }
  return { status: response.status, body: bodyValue };
}

function bodyError(response) {
  return typeof response.body === "string"
    ? response.body
    : response.body?.error ?? JSON.stringify(response.body);
}

function assertStatus(response, expected, context) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert(allowed.includes(response.status), `${context}: expected ${allowed.join("/")}, got ${response.status}: ${bodyError(response)}`);
}

function dossierBody(response) {
  return response.body?.dossier ?? response.body;
}

async function loginThroughPreview(account) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${origin}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("input-sign-in-email").fill(account.email);
  await page.getByTestId("input-sign-in-password").fill(account.password);
  const loginResponse = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/auth/login",
    { timeout: 15_000 },
  );
  await page.getByTestId("button-sign-in-submit").click();
  assert.equal((await loginResponse).status(), 204, `Preview login failed for ${account.label}`);
  await page.waitForURL(/\/(?:studio|characters|generate|projects)/u, { timeout: 15_000 });
  assert((await context.cookies(origin)).some((cookie) => cookie.name === "obtv_session"));
  account.browserContext = context;
  account.browserPage = page;
  return page;
}

async function createCharacter(account, overrides = {}) {
  const response = await api(account, "/characters", {
    method: "POST",
    body: json({
      name: overrides.name ?? `Reference Viewer ${account.label} ${runId.slice(0, 8)}`,
      description: overrides.description ?? "Isolated character-reference viewer fixture.",
      promptDescription: overrides.promptDescription ?? "A presenter in a copper scarf.",
    }),
  });
  assertStatus(response, 201, `${account.label} character creation`);
  const character = response.body?.character ?? response.body;
  assert(character?.id && character?.name);
  account.characterIds.push(character.id);
  return character;
}

async function setFixtureCharacterCreatedAt(account, characterIds, baseTime) {
  assert(characterIds.length > 0, "Created-at fixture helper requires owned character IDs");
  for (const [index, characterId] of characterIds.entries()) {
    const createdAt = new Date(baseTime.getTime() + index * 1000);
    const result = await pool.query(
      "UPDATE obtv_characters SET created_at=$1 WHERE tenant_id=$2 AND id=$3 RETURNING id",
      [createdAt, account.tenantId, characterId],
    );
    assert.equal(result.rowCount, 1, "Created-at fixture helper must update only an owned fixture character");
  }
}

async function tieFixtureCharacterCreatedAt(account, characterIds) {
  const tieTime = new Date("2000-01-01T00:00:00.000Z");
  const result = await pool.query(
    "UPDATE obtv_characters SET created_at=$1 WHERE tenant_id=$2 AND id=ANY($3::uuid[]) RETURNING id",
    [tieTime, account.tenantId, characterIds],
  );
  assert.equal(
    result.rowCount,
    characterIds.length,
    "Created-at tie fixture must update exactly the owned character IDs",
  );
}

function charactersList(response) {
  return response.body?.characters ?? response.body ?? [];
}

async function fetchCharacterList(account, context) {
  const response = await api(account, "/characters");
  assertStatus(response, 200, context);
  const characters = charactersList(response);
  assert(Array.isArray(characters), `${context} must return a character array`);
  return characters;
}

function assertCharacterIdOrder(characters, expectedIds, context) {
  assert.deepEqual(
    characters.map((character) => character.id),
    expectedIds,
    `${context} must preserve created_at ASC, id ASC ordering`,
  );
}

async function browserCharacterOrder(page, expectedNames, context) {
  for (const name of expectedNames) {
    await page.getByText(name, { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  }
  const fixtureNames = new Set(expectedNames);
  const visibleNames = (await page.locator("h3").allTextContents())
    .map((name) => name.trim())
    .filter((name) => fixtureNames.has(name));
  assert.deepEqual(visibleNames, expectedNames, `${context} must match the API character ordering`);
}

async function testCharacterOrdering(owner) {
  const suffix = runId.slice(0, 8);
  const initialNames = [`Order Z ${suffix}`, `Order Y ${suffix}`, `Order X ${suffix}`];
  const fixtureCharacters = [];
  for (const [index, name] of initialNames.entries()) {
    fixtureCharacters.push(await createCharacter(owner, {
      name,
      description: `Order fixture description ${index}`,
      promptDescription: `Order fixture prompt ${index}`,
    }));
  }
  const fixtureIds = fixtureCharacters.map((character) => character.id);
  await setFixtureCharacterCreatedAt(owner, fixtureIds, new Date("2020-01-01T00:00:00.000Z"));

  let characters = await fetchCharacterList(owner, "Initial character ordering");
  assertCharacterIdOrder(characters, fixtureIds, "Initial character ordering");
  assert.deepEqual(
    characters.map((character) => character.name),
    initialNames,
    "Initial fixture names must remain in creation order rather than alphabetical order",
  );

  await tieFixtureCharacterCreatedAt(owner, fixtureIds);
  const tiedIds = [...fixtureIds].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  characters = await fetchCharacterList(owner, "Tied character ordering");
  assertCharacterIdOrder(characters, tiedIds, "Tied character ordering");

  const firstCharacter = fixtureCharacters[0];
  const lastCharacter = fixtureCharacters.at(-1);
  const updatedFirstName = `Order First Updated ${suffix}`;
  const updatedLastName = `Order Last Updated ${suffix}`;
  const lastUpdate = await api(owner, `/characters/${lastCharacter.id}`, {
    method: "PATCH",
    body: json({
      name: updatedLastName,
      description: "Updated last fixture description",
      promptDescription: lastCharacter.promptDescription ?? "",
    }),
  });
  assertStatus(lastUpdate, 200, "Last character update");
  const firstUpdate = await api(owner, `/characters/${firstCharacter.id}`, {
    method: "PATCH",
    body: json({
      name: updatedFirstName,
      description: "Updated first fixture description",
      promptDescription: firstCharacter.promptDescription ?? "",
    }),
  });
  assertStatus(firstUpdate, 200, "First character update");

  characters = await fetchCharacterList(owner, "Ordering after first/last PATCH updates");
  assertCharacterIdOrder(characters, tiedIds, "Ordering after first/last PATCH updates");

  const referenceOwner = characters.find((character) => character.id === tiedIds[1]) ?? characters[1];
  const referenceUpload = await api(owner, `/characters/${referenceOwner.id}/assets`, {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-file-name": `order-reference-${suffix}.png`,
      "x-asset-label": "headshot",
    },
    body: originalPng,
  });
  assertStatus(referenceUpload, 201, "Reference addition in ordering fixture");
  characters = await fetchCharacterList(owner, "Ordering after adding a reference");
  assertCharacterIdOrder(characters, tiedIds, "Ordering after adding a reference");

  const fourth = await createCharacter(owner, {
    name: `Order Fourth ${suffix}`,
    description: "Fourth order fixture description",
    promptDescription: "Fourth order fixture prompt",
  });
  characters = await fetchCharacterList(owner, "Ordering after adding a fourth character");
  assertCharacterIdOrder(characters, [...tiedIds, fourth.id], "Ordering after adding a fourth character");
  const expectedNames = characters.map((character) => character.name);

  await owner.browserPage.goto(`${origin}/characters`, { waitUntil: "domcontentloaded" });
  await browserCharacterOrder(owner.browserPage, expectedNames, "Initial refreshed browser ordering");
  await owner.browserPage.reload({ waitUntil: "domcontentloaded" });
  await browserCharacterOrder(owner.browserPage, expectedNames, "Reloaded browser ordering");
  stageLog("order-only fixture verified created_at ordering, id tie-break, PATCH/reference stability, fourth append, and browser refresh");
}

async function openCharacterReferences(page, characterName) {
  await page.goto(`${origin}/characters`, { waitUntil: "domcontentloaded" });
  await page.getByText(characterName, { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  const cardText = page.getByText(characterName, { exact: true }).first();
  const card = cardText.locator("xpath=ancestor::*[.//button][1]");
  const edit = card.getByRole("button", { name: new RegExp(`^Edit\\s+${characterName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "i") });
  if (await edit.count()) await edit.click();
  else await cardText.click();
  const editor = page.getByRole("dialog").last();
  await editor.waitFor({ state: "visible", timeout: 10_000 });
  const tab = editor.getByRole("tab", { name: /Visual References|References/i });
  if (await tab.count()) await tab.click();
  else await editor.getByText(/Visual References|References/i).last().click();
  await editor.getByText(/Visual References|Generate a reference image/i).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
  return editor;
}

async function chooseUploadLabel(page, editor, pattern) {
  const select = editor.locator("#reference-target-view");
  assert(await select.count(), "Character references must expose the Target view picker");
  if (await select.count() && await select.isVisible().catch(() => false)) {
    await select.click();
    const option = page.getByRole("option", { name: pattern }).last();
    if (await option.count()) {
      await option.click();
      return;
    }
    await page.keyboard.press("Escape");
  }
  const button = editor.getByRole("button", { name: pattern }).last();
  if (await button.count() && await button.isVisible().catch(() => false)) {
    await button.click();
    return;
  }
  throw new Error(`Character reference upload target ${pattern} was not found`);
}

async function testReferenceFilterTargetSync(page, editor) {
  const targetPicker = editor.locator("#reference-target-view");
  const prompt = editor.getByPlaceholder("Describe the reference image...");
  assert(await targetPicker.count(), "Character references must expose the exact target view selector");
  assert(await prompt.count(), "Character references must expose the prompt while testing view filters");
  const labels = ["headshot", "profile", "three-quarter", "full-body", "expression", "wardrobe", "other"];
  for (const label of labels) {
    const displayLabel = label.replace(/-/g, " ");
    const filterButton = editor.getByRole("button", { name: new RegExp(`^${displayLabel}$`, "i") });
    await filterButton.waitFor({ state: "visible", timeout: 5_000 });
    await filterButton.click();
    assert.match(
      await targetPicker.innerText(),
      new RegExp(displayLabel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "i"),
      `${displayLabel} filter must select the matching target view`,
    );
    const expectedPrompt = label === "wardrobe"
      ? WARDROBE_PROMPT
      : `A ${displayLabel} shot of this character`;
    assert.equal(
      await prompt.inputValue(),
      expectedPrompt,
      `${displayLabel} filter must select its own fresh prompt default`,
    );
    if (label === "wardrobe") {
      assert.match(await prompt.inputValue(), /outfit shown in the source image, head to toe with shoes visible/i);
      assert.match(
        await prompt.inputValue(),
        /keep the original background; do not add a closet, clothing rack, hangers, or extra garments/i,
        "Wardrobe helper text must constrain clothing without inventing a scene",
      );
      assert.doesNotMatch(await prompt.inputValue(), /A wardrobe shot of this character/i);
    }
  }

  const allButton = editor.getByRole("button", { name: "All", exact: true });
  assert(await allButton.count(), "Reference filters must expose the All tab");
  await allButton.click();
  assert.match(
    await targetPicker.innerText(),
    /other/i,
    "All must preserve the most recently selected target view",
  );
  assert.equal(
    await prompt.inputValue(),
    "A other shot of this character",
    "All must preserve the most recently selected prompt draft",
  );

  await chooseUploadLabel(page, editor, /profile/i);
  assert.match(await targetPicker.innerText(), /profile/i, "Target view must be restored to profile");
  assert.equal(
    await prompt.inputValue(),
    "A profile shot of this character",
    "Restoring profile must leave its view-specific default ready for the lifecycle test",
  );
}

async function uploadThroughUi(page, editor, characterId, bytes, filename, labelPattern) {
  await chooseUploadLabel(page, editor, labelPattern);
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/characters/${characterId}/assets`
      && response.status() === 201,
    { timeout: 15_000 },
  );
  const inputs = page.locator('input[type="file"]');
  assert(await inputs.count(), "Character references must expose a native image upload input");
  let input = inputs.last();
  for (let index = 0; index < await inputs.count(); index += 1) {
    const candidate = inputs.nth(index);
    if ((await candidate.getAttribute("accept"))?.includes("image")) {
      input = candidate;
      break;
    }
  }
  await input.setInputFiles({ name: filename, mimeType: "image/png", buffer: bytes });
  const response = await responsePromise;
  const body = await response.json();
  const asset = body?.asset ?? body;
  assert(asset?.id ?? body?.assetId, `${filename} UI upload did not return an asset id`);
  return asset?.id ? asset : { ...asset, id: body.assetId, mediaUrl: body.mediaUrl };
}

async function findImage(page, mediaUrl) {
  const suffix = mediaUrl?.split("/").pop();
  const images = page.locator('img[src*="/api/media/"]');
  for (let index = 0; index < await images.count(); index += 1) {
    const image = images.nth(index);
    if ((await image.getAttribute("src"))?.includes(suffix ?? "__missing__")) return image;
  }
  throw new Error(`Reference thumbnail ${mediaUrl} was not rendered`);
}

async function waitForImage(page, mediaUrl, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      return await findImage(page, mediaUrl);
    } catch {
      await sleep(100);
    }
  }
  return findImage(page, mediaUrl);
}

async function selectReference(page, asset) {
  const sourcePicker = page.locator("#reference-source");
  assert(await sourcePicker.count(), "Character references must expose an image reference source picker");
  await sourcePicker.click();
  const option = page.getByRole("option").filter({ hasText: new RegExp(asset.label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "i") }).last();
  assert(await option.count(), `The source picker must expose the ${asset.label} reference`);
  await option.click();
  const selectedText = page.getByText(/Selected source:/i).last();
  await selectedText.waitFor({ state: "visible", timeout: 5_000 });
  assert.match(await selectedText.innerText(), new RegExp(asset.label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "i"));
}

async function selectCharacterModel(page, editor, pattern) {
  const modelPicker = editor.locator("#character-image-model");
  assert(await modelPicker.count(), "Character references must expose the image model picker");
  await modelPicker.click();
  const option = page.getByRole("option", { name: pattern }).last();
  assert(await option.count(), `The character image model option ${pattern} was not found`);
  await option.click();
}

async function assertCloudConsentState(editor, checked, generateDisabled) {
  const consent = editor.locator("#character-cloud-confirm");
  await consent.waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(
    await consent.getAttribute("data-state"),
    checked ? "checked" : "unchecked",
    `Cloud consent should be ${checked ? "checked" : "unchecked"}`,
  );
  assert.equal(await consent.isEnabled(), true, "Cloud consent must remain enabled before submission");
  assert.equal(
    await editor.getByRole("button", { name: "Generate with paid cloud", exact: true }).isDisabled(),
    generateDisabled,
    `Paid cloud generation should be ${generateDisabled ? "disabled" : "enabled"} when consent is ${checked ? "checked" : "unchecked"}`,
  );
}

async function testCloudModelConsent(page, editor, characterId, original, alternate, fakeWorkerState) {
  const modelPicker = editor.locator("#character-image-model");
  assert.match(await modelPicker.innerText(), /Local\s*·\s*FLUX\.2 Klein/i, "Local FLUX.2 Klein must be the default model");

  await selectCharacterModel(page, editor, /Cloud\s*·\s*Nano Banana Pro\s*·\s*paid/i);
  const warning = editor.getByText(
    "This uses the paid cloud provider and sends the selected reference image to it.",
    { exact: true },
  );
  await warning.waitFor({ state: "visible", timeout: 5_000 });
  assert.match(await warning.innerText(), /paid cloud provider.*sends the selected reference image/i);
  await assertCloudConsentState(editor, false, true);

  const consent = editor.locator("#character-cloud-confirm");
  await consent.click();
  await assertCloudConsentState(editor, true, false);

  await selectCharacterModel(page, editor, /Local\s*·\s*FLUX\.2 Klein/i);
  await warning.waitFor({ state: "hidden", timeout: 5_000 });
  await selectCharacterModel(page, editor, /Cloud\s*·\s*Nano Banana Pro\s*·\s*paid/i);
  await assertCloudConsentState(editor, false, true);

  await consent.click();
  await selectReference(page, alternate);
  await assertCloudConsentState(editor, false, true);
  await selectReference(page, original);
  await assertCloudConsentState(editor, false, true);
  await consent.click();

  const prompt = editor.getByPlaceholder("Describe the reference image...");
  assert(await prompt.count(), "Character references must expose a view-specific image prompt");
  await chooseUploadLabel(page, editor, /full[-\s]body/i);
  const fullBodyDefault = await prompt.inputValue();
  assert.match(fullBodyDefault, /full\s*body/i, "Full-body view must receive its own default prompt");
  assert.doesNotMatch(fullBodyDefault, /headshot/i, "Full-body default prompt must not retain the headshot draft");
  const fullBodyCustom = `${fullBodyDefault} with a custom full-body continuity detail`;
  await prompt.fill(fullBodyCustom);

  await chooseUploadLabel(page, editor, /headshot/i);
  const headshotPrompt = await prompt.inputValue();
  assert.match(headshotPrompt, /headshot/i, "Switching to headshot must show the headshot default prompt");
  assert.notEqual(headshotPrompt, fullBodyCustom, "Headshot must not reuse the full-body draft");

  await chooseUploadLabel(page, editor, /full[-\s]body/i);
  assert.equal(
    await prompt.inputValue(),
    fullBodyCustom,
    "Returning to full-body must restore its edited prompt draft",
  );

  const cloudRequestBodies = [];
  const submissionsBeforeCloud = fakeWorkerState.submissions;
  const generationUrl = `${origin}/api/characters/${characterId}/generate-image`;
  await page.route(generationUrl, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    cloudRequestBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 503,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Cloud generation disabled in local browser regression fixture." }),
    });
  });
  try {
    const cloudResponsePromise = page.waitForResponse(
      (response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/characters/${characterId}/generate-image`
        && response.status() === 503,
      { timeout: 10_000 },
    );
    await editor.getByRole("button", { name: "Generate with paid cloud", exact: true }).click();
    const cloudResponse = await cloudResponsePromise;
    assert.equal(cloudResponse.status(), 503, "Cloud browser regression must use the controlled disabled fixture response");
    await page.getByText("Cloud generation disabled in local browser regression fixture.", { exact: true })
      .waitFor({ state: "visible", timeout: 5_000 });
    const fullBodyCloudRequest = cloudRequestBodies[0];
    assert.equal(fullBodyCloudRequest?.modelId, "cloud-nano-banana-pro");
    assert.equal(fullBodyCloudRequest?.cloudConfirmed, true);
    assert.equal(fullBodyCloudRequest?.referenceAssetId, original.id);
    assert.equal(fullBodyCloudRequest?.referenceLabel, "full-body");
    assert.equal(fullBodyCloudRequest?.prompt, fullBodyCustom);
    assert.doesNotMatch(fullBodyCloudRequest?.prompt ?? "", /headshot/i);

    await chooseUploadLabel(page, editor, /wardrobe/i);
    assert.equal(
      await prompt.inputValue(),
      WARDROBE_PROMPT,
      "Cloud wardrobe request must use the explicit source-outfit prompt",
    );
    assert.doesNotMatch(await prompt.inputValue(), /A wardrobe shot of this character/i);
    await assertCloudConsentState(editor, false, true);
    await consent.click();
    const wardrobeResponsePromise = page.waitForResponse(
      (response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/characters/${characterId}/generate-image`
        && response.status() === 503,
      { timeout: 10_000 },
    );
    await editor.getByRole("button", { name: "Generate with paid cloud", exact: true }).click();
    const wardrobeResponse = await wardrobeResponsePromise;
    assert.equal(wardrobeResponse.status(), 503, "Wardrobe cloud request must use the controlled disabled fixture response");
    await page.getByText("Cloud generation disabled in local browser regression fixture.", { exact: true })
      .waitFor({ state: "visible", timeout: 5_000 });
    const wardrobeCloudRequest = cloudRequestBodies[1];
    assert.equal(wardrobeCloudRequest?.modelId, "cloud-nano-banana-pro");
    assert.equal(wardrobeCloudRequest?.cloudConfirmed, true);
    assert.equal(wardrobeCloudRequest?.referenceAssetId, original.id);
    assert.equal(wardrobeCloudRequest?.referenceLabel, "wardrobe");
    assert.equal(wardrobeCloudRequest?.prompt, WARDROBE_PROMPT);
    assert.doesNotMatch(wardrobeCloudRequest?.prompt ?? "", /A wardrobe shot of this character/i);
    assert.equal(cloudRequestBodies.length, 2, "Only the controlled full-body and wardrobe cloud requests should run");
  } finally {
    await page.unroute(generationUrl);
  }
  assert.equal(fakeWorkerState.submissions, submissionsBeforeCloud, "Cloud consent regression must never submit to the local worker");
  await chooseUploadLabel(page, editor, /profile/i);
  assert.equal(
    await prompt.inputValue(),
    "A generated original-reference view",
    "Resetting to profile must restore the existing local lifecycle draft",
  );
  await selectCharacterModel(page, editor, /Local\s*·\s*FLUX\.2 Klein/i);
}

function referencesFromRequest(body) {
  return [
    body?.referenceAssetId,
    body?.sourceAssetId,
    ...(body?.referenceAssetIds ?? []),
    ...(body?.sourceAssetIds ?? []),
  ].filter(Boolean);
}

async function waitForDossier(account, characterId, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let dossier;
  while (Date.now() < deadline) {
    dossier = dossierBody(await api(account, `/characters/${characterId}/dossier`));
    if (predicate(dossier)) return dossier;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for character dossier state: ${JSON.stringify(dossier)}`);
}

async function openImageViewer(page, asset) {
  const image = await waitForImage(page, asset.mediaUrl);
  await image.click();
  const viewer = page.getByRole("dialog").last();
  await viewer.waitFor({ state: "visible", timeout: 5_000 });
  assert(
    (await viewer.getAttribute("aria-label")) || (await viewer.getAttribute("aria-labelledby")),
    "Large reference viewer must have an accessible dialog name",
  );
  const largeImage = viewer.locator("img").first();
  await largeImage.waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForFunction((src) => [...document.images].some(image => image.src.endsWith(src || "__missing__") && image.complete && image.naturalWidth > 0), await largeImage.getAttribute("src"), { timeout: 5_000 });
  const imageState = await largeImage.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      alt: element.getAttribute("alt") ?? "",
      complete: element instanceof HTMLImageElement && element.complete,
      naturalWidth: element instanceof HTMLImageElement ? element.naturalWidth : 0,
      naturalHeight: element instanceof HTMLImageElement ? element.naturalHeight : 0,
      objectFit: style.objectFit,
    };
  });
  assert(imageState.alt.trim(), "Large reference viewer image must have accessible alternative text");
  assert(imageState.complete && imageState.naturalWidth > 0 && imageState.naturalHeight > 0);
  assert.notEqual(imageState.objectFit, "cover", "Large reference viewer must not crop the full image");
  const zoomIn = viewer.getByRole("button", { name: /zoom in|increase zoom|^\+$/i });
  const zoomOut = viewer.getByRole("button", { name: /zoom out|decrease zoom|^−$|^-$/i });
  assert(await zoomIn.count(), "Large reference viewer must expose an accessible zoom-in control");
  assert(await zoomOut.count(), "Large reference viewer must expose an accessible zoom-out control");
  const initialTransform = await largeImage.evaluate((element) => getComputedStyle(element).transform);
  await zoomIn.click();
  await page.waitForTimeout(350);
  const zoomedTransform = await largeImage.evaluate((element) => getComputedStyle(element).transform);
  assert.notEqual(zoomedTransform, initialTransform, "Zoom-in must change the large image scale");
  await zoomOut.click();
  return { viewer, largeImage, zoomIn, zoomOut };
}

async function customDeleteConfirmation(page, accept) {
  const confirmation = page.getByRole("alertdialog").last();
  if (await confirmation.count() && await confirmation.isVisible().catch(() => false)) {
    const button = confirmation.getByRole("button", { name: accept ? /delete|remove|confirm/i : /cancel|keep/i }).last();
    assert(await button.count(), "Delete confirmation must expose an accessible action");
    await button.click();
    await confirmation.waitFor({ state: "hidden", timeout: 5000 });
    await page.waitForTimeout(250);
    return true;
  }
  return false;
}

async function clickDelete(page, scope, accept, assetId) {
  const deleteButton = scope.getByRole("button", { name: /delete|remove reference/i }).last();
  assert(await deleteButton.count(), "Reference delete must be available from the current viewer or thumbnail");
  let nativeDialog = false;
  const dialogHandler = async (dialog) => {
    nativeDialog = true;
    await (accept ? dialog.accept() : dialog.dismiss());
  };
  page.once("dialog", dialogHandler);
  const responsePromise = accept
    ? page.waitForResponse(
      (response) => response.request().method() === "DELETE"
        && new URL(response.url()).pathname.endsWith(`/assets/${assetId}`)
        && response.status() === 204,
      { timeout: 15_000 },
    )
    : null;
  await deleteButton.click();
  await page.waitForTimeout(150);
  if (!nativeDialog) await customDeleteConfirmation(page, accept);
  page.off("dialog", dialogHandler);
  if (accept) await responsePromise;
  else await sleep(150);
}

async function thumbnailDeleteAction(page, asset) {
  const thumbnail = page.locator(`button[aria-label^="Open "] img[src="${asset.mediaUrl}"]`).first();
  await thumbnail.waitFor({ state: "visible", timeout: 10000 });
  const card = thumbnail.locator("xpath=../..");
  const directDelete = card.getByRole("button", { name: /delete|remove reference/i }).last();
  if (await directDelete.count()) return directDelete;
  const buttons = card.getByRole("button");
  assert(await buttons.count(), "Reference thumbnail must expose an action button");
  await buttons.last().click();
  const menu = page.getByRole("menu").last();
  await menu.waitFor({ state: "visible", timeout: 5_000 });
  const menuDelete = menu.getByRole("menuitem", { name: /delete|remove reference/i }).last();
  assert(await menuDelete.count(), "Reference thumbnail action menu must expose a delete action");
  return menuDelete;
}

async function assertNoRawHtml(page, context) {
  const text = await page.locator("body").innerText();
  assert(!/<\/?(?:html|head|body|title|script|style)\b/i.test(text), `${context} exposed raw HTML`);
}

async function insertActiveFixtureJob(
  account,
  characterId,
  referenceAssetId,
  referenceLabel = "profile",
  prompt = "Capability fixture",
) {
  const response = await api(account, `/characters/${characterId}/generate-image`, {
    method: "POST",
    body: json({ prompt, seed: 71, referenceAssetId, referenceLabel, requestKey: randomUUID() }),
  });
  return response;
}

async function testReferenceLifecycle(owner, foreign, character) {
  const page = owner.browserPage;
  const editor = await openCharacterReferences(page, character.name);
  const originalUi = await uploadThroughUi(
    page,
    editor,
    character.id,
    originalPng,
    `original-${runId}.png`,
    /headshot|original/i,
  );
  const alternateUi = await uploadThroughUi(
    page,
    editor,
    character.id,
    alternatePng,
    `alternate-${runId}.png`,
    /profile|alternate/i,
  );
  stageLog(`UI uploads returned original=${originalUi.id ?? "missing"} alternate=${alternateUi.id ?? "missing"}`);
  const afterUploads = dossierBody(await api(owner, `/characters/${character.id}/dossier`));
  const original = afterUploads.assets.find((asset) => asset.id === originalUi.id);
  const alternate = afterUploads.assets.find((asset) => asset.id === alternateUi.id);
  assert(original?.id && alternate?.id, `Uploads must persist by returned IDs: ${JSON.stringify(afterUploads.assets)}`);
  assert.notEqual(original.id, alternate.id, "Original and alternate uploads must be distinct assets");
  await page.screenshot({ path: "/tmp/character-reference-card-controls.png" });
  stageLog(`dossier persisted original=${original.id} label=${original.label}; alternate=${alternate.id} label=${alternate.label}`);
  assert(fakeWorker.state.uploads.length === 0, "Fixture uploads must not be sent to the worker before generation");

  await selectReference(page, original);
  stageLog(`selected source through #reference-source: ${original.id}`);
  await testReferenceFilterTargetSync(page, editor);
  const prompt = editor.getByPlaceholder("Describe the reference image...");
  if (await prompt.count()) await prompt.fill("A generated original-reference view");
  await testCloudModelConsent(page, editor, character.id, original, alternate, fakeWorker.state);
  fakeWorker.setMode("prolonged");
  const submissionsBefore = fakeWorker.state.submissions;
  const requestPromise = page.waitForRequest(
    (request) => request.method() === "POST"
      && new URL(request.url()).pathname === `/api/characters/${character.id}/generate-image`,
    { timeout: 10_000 },
  );
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/characters/${character.id}/generate-image`,
    { timeout: 10_000 },
  );
  await editor.getByRole("button", { name: /generate image/i }).click();
  const [generateRequest, enqueueResponse] = await Promise.all([requestPromise, responsePromise]);
  assert.equal(enqueueResponse.status(), 202, `Character generation must be accepted: ${await enqueueResponse.text()}`);
  const requestBody = generateRequest.postDataJSON();
  stageLog(`generate request references=${JSON.stringify(referencesFromRequest(requestBody))}`);
  assert.equal(requestBody.modelId, "local-flux2-klein-4b", "Local positive lifecycle must submit the local model explicitly");
  assert(!("cloudConfirmed" in requestBody), "Local positive lifecycle must not submit paid cloud consent");
  assert(
    referencesFromRequest(requestBody).includes(original.id),
    `Generate request must identify the selected original reference, got ${JSON.stringify(requestBody)}`,
  );
  assert(!referencesFromRequest(requestBody).includes(alternate.id), "Generate request must not silently use the newer alternate");

  const activeDossier = await waitForDossier(
    owner,
    character.id,
    (dossier) => ["QUEUED", "RUNNING"].includes(dossier.imageGeneration?.status),
  );
  const jobId = activeDossier.imageGeneration.id;
  stageLog(`generation acknowledged job=${jobId} status=${activeDossier.imageGeneration.status}`);
  const promptSubmissionDeadline = Date.now() + 15_000;
  while (fakeWorker.state.submissions < submissionsBefore + 1 && Date.now() < promptSubmissionDeadline) {
    await sleep(100);
  }
  assert.equal(
    fakeWorker.state.submissions,
    submissionsBefore + 1,
    "Character generation must submit before progress telemetry is enabled",
  );
  const generationCardTestId = `status-character-image-generation-${character.id}`;
  const generationCard = page.getByTestId(generationCardTestId);
  await generationCard.waitFor({ state: "visible", timeout: 15_000 });
  const idleProgress = generationCard.getByTestId(`status-character-image-generation-progress-${character.id}`);
  await idleProgress.waitFor({ state: "visible", timeout: 15_000 });
  assert.match(
    await idleProgress.innerText(),
    /Waiting for local provider progress/i,
    "An active character render must not invent a percentage before worker telemetry",
  );

  fakeWorker.beginProgressTelemetry();
  const renderingDossier = await waitForDossier(
    owner,
    character.id,
    (dossier) => (
      dossier.imageGeneration?.id === jobId
      && dossier.imageGeneration.progress === 0.5
      && dossier.imageGeneration.progressStep === 2
      && dossier.imageGeneration.progressTotalSteps === 4
      && dossier.imageGeneration.progressStage === "rendering"
    ),
  );
  assert.equal(renderingDossier.imageGeneration.progress, 0.5);
  assert.equal(renderingDossier.imageGeneration.progressStep, 2);
  assert.equal(renderingDossier.imageGeneration.progressTotalSteps, 4);
  assert.equal(renderingDossier.imageGeneration.progressStage, "rendering");
  assert(
    fakeWorker.state.websocketClientsById.has(jobId),
    "The Comfy progress socket must connect with the durable job ID as clientId",
  );

  const foreignProgressDeadline = Date.now() + 10_000;
  while (fakeWorker.state.foreignProgressEvents < 1 && Date.now() < foreignProgressDeadline) {
    await sleep(50);
  }
  assert.equal(
    fakeWorker.state.foreignProgressEvents,
    1,
    "The fixture worker must emit one foreign prompt progress event",
  );
  // The foreign event is value=4/max=4. Give the durable observer enough time
  // to persist it if prompt filtering regresses, while matching telemetry is
  // paused so a later valid event cannot hide that regression.
  await sleep(800);
  const afterForeignProgress = dossierBody(await api(owner, `/characters/${character.id}/dossier`));
  assert.equal(
    afterForeignProgress.imageGeneration?.progress,
    0.5,
    "Progress from another prompt must not update the character render",
  );
  fakeWorker.resumeProgressTelemetry();

  const progressText = generationCard.getByTestId(`text-character-image-generation-progress-${character.id}`);
  const progressTextDeadline = Date.now() + 15_000;
  let renderedProgressText = "";
  while (Date.now() < progressTextDeadline) {
    renderedProgressText = await progressText.textContent().catch(() => "") ?? "";
    if (/50%\s*sampler.*step\s*2\s*of\s*4/i.test(renderedProgressText)) break;
    await sleep(200);
  }
  assert.match(
    renderedProgressText,
    /50%\s*sampler.*step\s*2\s*of\s*4/i,
    "The active-generation card must show sampler percentage and step count",
  );
  const progressStage = generationCard.getByTestId(`status-character-image-generation-stage-${character.id}`);
  assert.match(await progressStage.innerText(), /Sampling/i);
  const progressBar = generationCard.getByTestId(`progress-character-image-generation-${character.id}`);
  await progressBar.waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(await progressBar.getAttribute("aria-valuenow"), "50");
  const gallery = generationCard.locator("xpath=following-sibling::div[1]");
  await gallery.waitFor({ state: "visible", timeout: 5_000 });
  const cardBox = await generationCard.boundingBox();
  const galleryBox = await gallery.boundingBox();
  assert(cardBox && galleryBox && cardBox.y < galleryBox.y, "Progress card must appear above the reference gallery");
  stageLog("real Comfy progress reached the dossier and prominent reference card");

  const submissionsBeforeProgressReload = fakeWorker.state.submissions;
  await page.reload({ waitUntil: "domcontentloaded" });
  await openCharacterReferences(page, character.name);
  const reloadedGenerationCard = page.getByTestId(generationCardTestId);
  await reloadedGenerationCard.waitFor({ state: "visible", timeout: 15_000 });
  const reloadedProgressText = reloadedGenerationCard.getByTestId(`text-character-image-generation-progress-${character.id}`);
  const reloadedProgressDeadline = Date.now() + 15_000;
  let reloadedText = "";
  while (Date.now() < reloadedProgressDeadline) {
    reloadedText = await reloadedProgressText.textContent().catch(() => "") ?? "";
    if (/50%\s*sampler.*step\s*2\s*of\s*4/i.test(reloadedText)) break;
    await sleep(200);
  }
  assert.match(
    reloadedText,
    /50%\s*sampler.*step\s*2\s*of\s*4/i,
    "Reload must retain the persisted worker progress in the reference card",
  );
  assert.equal(
    fakeWorker.state.submissions,
    submissionsBeforeProgressReload,
    "Reloading an active character render must not submit a duplicate prompt",
  );
  const reloadedProgressDossier = dossierBody(await api(owner, `/characters/${character.id}/dossier`));
  assert.equal(reloadedProgressDossier.imageGeneration?.progress, 0.5);
  assert.equal(reloadedProgressDossier.imageGeneration?.progressStep, 2);
  assert.equal(reloadedProgressDossier.imageGeneration?.progressTotalSteps, 4);
  assert.equal(reloadedProgressDossier.imageGeneration?.progressStage, "rendering");
  stageLog("active progress survived reload without duplicate worker submission");

  const activeDelete = await api(owner, `/characters/${character.id}/assets/${original.id}`, { method: "DELETE" });
  assertStatus(activeDelete, 409, "Source reference delete while generation is active");
  stageLog("active source deletion correctly returned 409");

  const foreignDelete = await api(foreign, `/characters/${character.id}/assets/${original.id}`, { method: "DELETE" });
  assert([403, 404].includes(foreignDelete.status), "Foreign tenant must not delete the source reference");

  const jobRow = await pool.query(
    "SELECT reference_asset_ids, provider_task_metadata FROM obtv_image_studio_jobs WHERE id=$1 AND tenant_id=$2",
    [jobId, owner.tenantId],
  );
  assert.equal(jobRow.rows.length, 1, "Character generation must be persisted in the owner tenant");
  assert.deepEqual(
    jobRow.rows[0].reference_asset_ids,
    [original.id],
    "The durable generation job must retain the selected original reference, not the newer alternate",
  );
  assert.equal(jobRow.rows[0].provider_task_metadata?.referenceUsed, true, "Provider metadata must record that this is reference-conditioned");
  assert.equal(
    jobRow.rows[0].provider_task_metadata?.sourceReference?.assetId,
    original.id,
    "Provider metadata must snapshot the selected original reference",
  );
  stageLog("database reference IDs and provider source snapshot verified");

  const submissionDeadline = Date.now() + 15_000;
  while (fakeWorker.state.submissions < submissionsBefore + 1 && Date.now() < submissionDeadline) await sleep(100);
  assert.equal(fakeWorker.state.submissions, submissionsBefore + 1, "Character generation must submit once to the fixture worker");
  const submitted = fakeWorker.state.workflows.at(-1);
  assert(submitted?.workflow, "Fixture worker must capture the character workflow");
  assert.equal(submitted.clientId, jobId, "The Comfy prompt must use the durable job ID as client_id");
  const workflow = submitted.workflow;
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
  assert(
    load && scale && encode && references.length === 2 && empty && scheduler && clip && zero && guider && sampler,
    "Reference generation must use the native FLUX.2 Klein edit workflow nodes",
  );
  const originalUpload = fakeWorker.state.uploads.find((upload) => upload.body.includes(originalPng));
  const alternateUpload = fakeWorker.state.uploads.find((upload) => upload.body.includes(alternatePng));
  assert(originalUpload, "Fixture worker must receive the selected original image bytes");
  assert(!alternateUpload, "Fixture worker must not receive the newer alternate image bytes");
  assert.equal(fakeWorker.state.uploads.length, 1, "Only the selected original reference may be uploaded to the worker");
  assert.deepEqual(
    originalUpload.fileBytes,
    originalPng,
    "Native reference upload must preserve the selected source bytes exactly",
  );
  const sourceDimensions = pngDimensions(originalUpload.fileBytes);
  assert(sourceDimensions, "Native source upload must remain a valid PNG");
  assert.notEqual(
    sourceDimensions.width / sourceDimensions.height,
    768 / 1024,
    "The fixture source aspect must differ from the requested target canvas",
  );
  assert.equal(load.inputs.image, originalUpload.name, "LoadImage must receive the selected original upload");
  assert.deepEqual(scale.inputs, {
    image: [loadId, 0],
    upscale_method: "nearest-exact",
    megapixels: 1,
    resolution_steps: 1,
  }, "Native source resize must use the verified total-pixels schema");
  assert(
    !("width" in scale.inputs) && !("height" in scale.inputs) && !("crop" in scale.inputs),
    "Native source resize must preserve source aspect ratio independently from target dimensions",
  );
  assert.deepEqual(encode.inputs.pixels, [scaleId, 0], "VAEEncode must consume the resized source");
  assert.deepEqual(encode.inputs.vae, [findWorkflowNode(workflow, "VAELoader")?.[0], 0]);
  assert.deepEqual(references[0][1].inputs, {
    conditioning: [clipId, 0],
    latent: [encodeId, 0],
  }, "ReferenceLatent must condition the positive prompt");
  assert.deepEqual(references[1][1].inputs, {
    conditioning: [zeroId, 0],
    latent: [encodeId, 0],
  }, "ReferenceLatent must condition the zeroed negative prompt");
  assert.deepEqual(guider.inputs, {
    model: [findWorkflowNode(workflow, "UNETLoader")?.[0], 0],
    positive: [references[0][0], 0],
    negative: [references[1][0], 0],
    cfg: 1,
  }, "CFGGuider must use both native reference-conditioned values at guidance 1");
  assert.deepEqual(empty.inputs, { width: 768, height: 1024, batch_size: 1 });
  assert.equal(scheduler.inputs.steps, 4);
  assert.deepEqual(sampler.inputs.sigmas, [schedulerId, 0], "Sampler must use the complete native scheduler stream");
  assert.deepEqual(sampler.inputs.latent_image, [emptyId, 0], "Native sampler must start from a fresh target latent");
  assert(!("denoise" in sampler.inputs), "Native sampler must not receive a denoise parameter");
  assert.equal(workflow[samplerId]?.class_type, "SamplerCustomAdvanced");
  assert.equal(Object.values(workflow).some((node) => node?.class_type === "ImageScale"), false);
  assert.equal(Object.values(workflow).some((node) => node?.class_type === "SplitSigmas"), false);
  assert.equal(Object.values(workflow).some((node) => node?.class_type === "RepeatLatentBatch"), false);
  const promptText = String(clip.inputs.text ?? "");
  assert.match(promptText, /image edit instruction: use the original visual reference as authoritative/i);
  assert.match(promptText, /same unchanged subject; apply the requested view change and only the explicit additional user edit below/i);
  assert.match(promptText, /strict 90-degree left-facing side profile; exactly one eye visible/i);
  assert.match(promptText, /preserve the original face, hair texture, hair length, hair part, skin details, visible clothing fabric, neckline, and jewelry/i);
  assert.match(promptText, /do not introduce props, equipment, new clothing, or a new background scene unless the explicit additional edit requests it/i);
  assert.match(promptText, /additional user edit instruction: a generated original-reference view/i);
  assert.doesNotMatch(promptText, /production character reference image|character:\s*reference viewer|a presenter in a copper scarf|role:|performance notes|biography|host/i);
  assert.doesNotMatch(promptText, /front-facing|facing camera/i);
  stageLog(`worker captured native reference workflow loadImage=${load.inputs.image} resize=total-pixels`);

  fakeWorker.setMode("complete");
  const completed = await waitForDossier(
    owner,
    character.id,
    (dossier) => dossier.imageGeneration?.id === jobId && dossier.imageGeneration.status === "COMPLETED",
  );
  const generated = completed.assets.find((asset) => asset.id === completed.imageGeneration.assetId);
  assert(generated?.id, "Completed generation must attach a generated character reference");
  const characters = await api(owner, "/characters");
  const listedCharacter = (characters.body?.characters ?? characters.body)?.find((candidate) => candidate.id === character.id);
  assert.equal(listedCharacter?.thumbnail, character.thumbnail ?? null, "Conditioned output must not replace the original thumbnail");
  stageLog(`generation completed asset=${generated.id}; original thumbnail preserved`);

  const threeQuarterResponse = await insertActiveFixtureJob(
    owner,
    character.id,
    original.id,
    "three-quarter",
    "A requested three-quarter continuity view",
  );
  assert.equal(threeQuarterResponse.status, 202, "Three-quarter native reference generation must be accepted");
  const threeQuarterJobId = threeQuarterResponse.body.id;
  assert(threeQuarterJobId, "Three-quarter generation must return a durable job ID");
  const threeQuarterDossier = await waitForDossier(
    owner,
    character.id,
    (dossier) => dossier.imageGeneration?.id === threeQuarterJobId
      && dossier.imageGeneration.status === "COMPLETED",
  );
  const threeQuarterWorkflow = fakeWorker.state.workflows.at(-1)?.workflow;
  assert(threeQuarterWorkflow, "Fixture worker must capture the three-quarter workflow");
  const [, threeQuarterClip] = findWorkflowNode(threeQuarterWorkflow, "CLIPTextEncode") ?? [];
  const threeQuarterGenerated = threeQuarterDossier.assets.find(
    (asset) => asset.id === threeQuarterDossier.imageGeneration.assetId,
  );
  assert(threeQuarterGenerated?.id, "Three-quarter generation must attach a generated reference");
  const threeQuarterPrompt = String(threeQuarterClip?.inputs?.text ?? "");
  assert.match(threeQuarterPrompt, /image edit instruction: use the original visual reference as authoritative/i);
  assert.match(threeQuarterPrompt, /same unchanged subject; apply the requested view change and only the explicit additional user edit below/i);
  assert.match(threeQuarterPrompt, /explicit 45-degree three-quarter view/i);
  assert.match(threeQuarterPrompt, /preserve the original face, hair texture, hair length, hair part, skin details, visible clothing fabric, neckline, and jewelry/i);
  assert.match(threeQuarterPrompt, /do not introduce props, equipment, new clothing, or a new background scene unless the explicit additional edit requests it/i);
  assert.match(threeQuarterPrompt, /additional user edit instruction: a requested three-quarter continuity view/i);
  assert.doesNotMatch(threeQuarterPrompt, /production character reference image|character:\s*reference viewer|a presenter in a copper scarf|role:|performance notes|biography|host/i);
  assert.doesNotMatch(threeQuarterPrompt, /front-facing|facing camera/i);
  stageLog("profile and three-quarter prompts preserve the original without forcing a camera-facing pose");

  const alternateViewer = await openImageViewer(page, alternate);
  await alternateViewer.zoomIn.click();
  await alternateViewer.zoomOut.click();
  await clickDelete(page, alternateViewer.viewer, false, alternate.id);
  await page.screenshot({ path: "/tmp/reference-viewer-after-cancel.png" });
  stageLog(`after cancel dialogs=${await page.getByRole("dialog").count()} buttons=${JSON.stringify(await page.getByRole("dialog").last().getByRole("button").allTextContents())}`);
  assert(dossierBody(await api(owner, `/characters/${character.id}/dossier`)).assets.some((asset) => asset.id === alternate.id), "Cancelling viewer deletion must keep the alternate");
  await clickDelete(page, alternateViewer.viewer, true, alternate.id);
  assert(!dossierBody(await api(owner, `/characters/${character.id}/dossier`)).assets.some((asset) => asset.id === alternate.id), "Confirmed viewer deletion must remove the alternate");
  stageLog("viewer delete cancellation and confirmation verified");
  await page.getByRole("dialog").last().getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForTimeout(250);

  await page.goto(`${origin}/characters`, { waitUntil: "domcontentloaded" });
  await openCharacterReferences(page, character.name);
  const generatedDelete = await thumbnailDeleteAction(page, generated);
  let nativeCancel = false;
  const cancelHandler = async (dialog) => {
    nativeCancel = true;
    await dialog.dismiss();
  };
  page.once("dialog", cancelHandler);
  await generatedDelete.click();
  await page.waitForTimeout(150);
  const customCancel = !nativeCancel && await customDeleteConfirmation(page, false);
  if (!nativeCancel && !customCancel) page.off("dialog", cancelHandler);
  assert(nativeCancel || customCancel, "Thumbnail deletion must ask for confirmation before removing a reference");
  assert(dossierBody(await api(owner, `/characters/${character.id}/dossier`)).assets.some((asset) => asset.id === generated.id), "Cancelling thumbnail deletion must retain generated reference");
  const confirmDelete = await thumbnailDeleteAction(page, generated);
  const generatedDeleteResponse = page.waitForResponse(
    (response) => response.request().method() === "DELETE"
      && new URL(response.url()).pathname.endsWith(`/assets/${generated.id}`)
      && response.status() === 204,
    { timeout: 15_000 },
  );
  let nativeConfirm = false;
  const confirmHandler = async (dialog) => {
    nativeConfirm = true;
    await dialog.accept();
  };
  page.once("dialog", confirmHandler);
  await confirmDelete.click();
  if (!nativeConfirm) await customDeleteConfirmation(page, true);
  if (!nativeConfirm) page.off("dialog", confirmHandler);
  await generatedDeleteResponse;
  const afterGeneratedDelete = dossierBody(await api(owner, `/characters/${character.id}/dossier`));
  assert(!afterGeneratedDelete.assets.some((asset) => asset.id === generated.id), "Deleted generated reference must not reappear");
  const listAfterGeneratedDelete = await api(owner, "/characters");
  const ownerCharacterAfterDelete = (listAfterGeneratedDelete.body?.characters ?? listAfterGeneratedDelete.body)
    ?.find?.((candidate) => candidate.id === character.id);
  assert.equal(ownerCharacterAfterDelete?.thumbnail ?? null, null, "Deleting the generated primary must clear the thumbnail");
  stageLog("thumbnail delete cancellation and confirmation verified; generated asset stayed deleted");

  const foreignDossier = await api(foreign, `/characters/${character.id}/dossier`);
  assert([403, 404].includes(foreignDossier.status), "Foreign tenant must not read the owner dossier");
  const foreignCharacters = await api(foreign, "/characters");
  assert(!(foreignCharacters.body?.characters ?? foreignCharacters.body).some?.((candidate) => candidate.id === character.id), "Foreign character list must not include the owner character");
  const foreignJobs = await api(foreign, "/image-studio/jobs?limit=100");
  if (foreignJobs.status === 200) {
    assert(!(foreignJobs.body?.jobs ?? []).some((job) => job.id === jobId), "Foreign job list must not include the owner job");
  }
  const foreignGenerate = await api(foreign, `/characters/${character.id}/generate-image`, {
    method: "POST",
    body: json({ prompt: "Cross-tenant attempt", referenceAssetId: original.id, requestKey: randomUUID() }),
  });
  assert([403, 404].includes(foreignGenerate.status), "Foreign tenant must not generate for the owner character");
  const foreignMedia = await fetch(new URL(original.mediaUrl, origin), {
    headers: { origin, cookie: `obtv_session=${foreign.token}` },
  });
  assert([403, 404].includes(foreignMedia.status), "Foreign tenant must not read the owner reference media");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileEditor = await openCharacterReferences(page, character.name);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
    true,
    "Mobile reference viewer controls must not overflow horizontally",
  );
  assert(await mobileEditor.getByRole("button", { name: /upload image|upload reference/i }).count(), "Mobile upload control must remain accessible");
  const persisted = dossierBody(await api(owner, `/characters/${character.id}/dossier`));
  assert(persisted.assets.some((asset) => asset.id === original.id), "Original reference must survive reload");
  assert(!persisted.assets.some((asset) => asset.id === alternate.id || asset.id === generated.id), "Deleted references must stay deleted after reload");
  const mobileViewer = await openImageViewer(page, original);
  assert(await mobileViewer.viewer.getByRole("button", { name: /close|dismiss/i }).count(), "Mobile viewer must retain an accessible close control");
  await mobileViewer.viewer.getByRole("button", { name: /close|dismiss/i }).last().click();
  await assertNoRawHtml(page, "Mobile character references");
  stageLog("reload persistence, mobile controls, and tenant isolation verified");
}

async function cleanupAccount(account) {
  try {
    const files = await pool.query(
      `SELECT ca.storage_key
         FROM obtv_character_assets ca
         JOIN obtv_characters c ON c.id=ca.character_id
        WHERE c.tenant_id=$1`,
      [account.tenantId],
    );
    for (const characterId of account.characterIds) {
      await api(account, `/characters/${characterId}`, { method: "DELETE" }).catch(() => undefined);
    }
    for (const row of files.rows) {
      await rm(path.resolve(process.env.OBTV_MEDIA_ROOT ?? "data/obtv-media", row.storage_key), { force: true }).catch(() => undefined);
    }
    await pool.query("UPDATE obtv_generation_jobs SET voice_character_id=NULL WHERE tenant_id=$1", [account.tenantId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_image_studio_jobs WHERE tenant_id=$1", [account.tenantId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_image_studio_assets WHERE tenant_id=$1", [account.tenantId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_generation_jobs WHERE tenant_id=$1", [account.tenantId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_characters WHERE tenant_id=$1", [account.tenantId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_tenant_memberships WHERE tenant_id=$1", [account.tenantId]).catch(() => undefined);
    await pool.query("UPDATE obtv_users SET active_tenant_id=NULL WHERE id=$1", [account.userId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_auth_sessions WHERE user_id=$1", [account.userId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_tenants WHERE id=$1", [account.tenantId]).catch(() => undefined);
    await pool.query("DELETE FROM obtv_users WHERE id=$1", [account.userId]).catch(() => undefined);
  } catch (error) {
    console.error(`Character reference fixture cleanup failed (${account.label}, run ${runId}): ${safeError(error)}`);
  }
}

try {
  if (orderOnly) {
    const owner = await createAccount("Order");
    stageLog("order-only fixture tenant created");
    browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ["--no-sandbox"] });
    await loginThroughPreview(owner);
    await testCharacterOrdering(owner);
    console.log("PASS: order-only character API and refreshed browser ordering");
  } else {
    fakeWorker = await startMockWorker();
    stageLog(`mock worker listening at ${fakeWorker.apiBaseUrl}`);
    await insertMockWorker();
    stageLog("isolated mock worker registered");
    const owner = await createAccount("Owner");
    const foreign = await createAccount("Foreign");
    stageLog("owner and foreign fixture tenants created");
    browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ["--no-sandbox"] });
    await loginThroughPreview(owner);
    const character = await createCharacter(owner);
    stageLog(`owner character created id=${character.id}`);
    await testReferenceLifecycle(owner, foreign, character);
    console.log("PASS: native original-reference conditioning, exact source upload, aspect-preserving resize, profile/three-quarter prompt views, accessible uncropped viewer zoom, active-source delete guard, confirmed generated-reference delete, reload persistence, mobile controls, and tenant isolation");
  }
} catch (error) {
  process.exitCode = 1;
  console.error(`FAIL character reference viewer: ${safeError(error)}`);
} finally {
  await browser?.close().catch(() => undefined);
  for (const account of fixtures) await cleanupAccount(account);
  if (workerIds.length) {
    await pool.query("DELETE FROM obtv_comfy_servers WHERE id=ANY($1::uuid[])", [workerIds]).catch(() => undefined);
  }
  await fakeWorker?.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
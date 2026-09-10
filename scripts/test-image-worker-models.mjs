#!/usr/bin/env node
// Uses GPU capacity: submits three real ComfyUI image renders.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.env.NODE_ENV === "production") throw new Error("Development test only");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
if (args.includes("--help")) {
  console.log("Usage: node scripts/test-image-worker-models.mjs (--worker ID | --api-url URL)");
  process.exit(0);
}
const workerId = option("--worker") ?? option("--worker-id");
const apiUrlArgument = option("--api-url");
if (Boolean(workerId) === Boolean(apiUrlArgument)) {
  throw new Error("Specify exactly one of --worker ID or --api-url URL");
}

const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const buildDirectory = await mkdtemp(join(tmpdir(), "obtv-image-worker-adapter-"));
const adapterBundle = join(buildDirectory, "image-studio-adapters.mjs");
const esbuild = new URL("../artifacts/api-server/node_modules/.bin/esbuild", import.meta.url).pathname;
execFileSync(esbuild, [
  "artifacts/api-server/src/lib/image-studio-adapters.ts",
  "--bundle",
  "--platform=node",
  "--format=esm",
  `--outfile=${adapterBundle}`,
], { cwd: new URL("..", import.meta.url), stdio: ["ignore", "ignore", "pipe"] });
const {
  cancelImageTask,
  checkLocalImageModel,
  pollImageTask,
  submitImageTask,
} = await import(`${pathToFileURL(adapterBundle).href}?v=${Date.now()}`);

const modelIds = [
  "local-flux2-klein-4b",
  "local-qwen-image-2512",
  "local-z-image-turbo",
];
const requiredTags = ["flux2-klein", "qwen-image-2512", "z-image-turbo"];
const deadlineMs = 8 * 60 * 1000;
let connection;
let server;
let originalEnabled;
let lockHeld = false;
let lockedServerId;
let leaveDisabled = false;
let currentTask;
let signal;

for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(name, () => {
    signal ??= name;
  });
}

function normalizedUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function serverFromRow(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    hostname: row.hostname,
    apiBaseUrl: row.api_base_url,
    websocketUrl: row.websocket_url,
    gpuName: row.gpu_name,
    vramGb: row.vram_gb,
    tags: [...new Set([...(row.tags ?? []), ...requiredTags])],
    enabled: true,
    priority: row.priority,
    maxConcurrentJobs: row.max_concurrent_jobs,
    status: "ONLINE",
    queueSize: row.queue_size,
    activeJobCount: row.active_job_count,
    memoryUsedGb: row.memory_used_gb,
    lastHeartbeat: row.last_heartbeat,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readQueue() {
  const response = await fetch(new URL("/queue", server.apiBaseUrl), {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Worker queue check returned HTTP ${response.status}`);
  const queue = await response.json();
  if (!queue || !Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) {
    throw new Error("Worker returned an invalid queue response");
  }
  return queue;
}

function queueHas(queue, promptId) {
  return JSON.stringify([queue.queue_running, queue.queue_pending]).includes(promptId);
}

function pngDimensions(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/(?:postgres(?:ql)?):\/\/\S+/gi, "[database connection redacted]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[credentials-redacted]@");
}

async function waitForResult(task) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (signal) throw new Error(`Received ${signal}`);
    try {
      const result = await pollImageTask(task);
      if (result.status === "COMPLETED") return result;
    } catch (error) {
      if (!error?.retryable) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out after 8 minutes (${task.requestId})`);
}

async function cancelOwnTaskSafely() {
  if (!currentTask) return true;
  try {
    const queueBefore = await readQueue();
    if (queueHas(queueBefore, currentTask.requestId)) {
      await cancelImageTask(currentTask);
    }
    const queueAfter = await readQueue();
    return !queueHas(queueAfter, currentTask.requestId);
  } catch {
    return false;
  }
}

try {
  connection = await pool.connect();
  const rows = (await connection.query(
    "SELECT * FROM obtv_comfy_servers ORDER BY created_at",
  )).rows;
  const matches = workerId
    ? rows.filter((row) => row.id === workerId)
    : rows.filter((row) => {
      try {
        return normalizedUrl(row.api_base_url) === normalizedUrl(apiUrlArgument);
      } catch {
        return false;
      }
    });
  assert.equal(matches.length, 1, matches.length ? "Configured worker selector is ambiguous" : "Configured worker not found");
  const row = matches[0];
  originalEnabled = row.enabled;

  const lock = await connection.query(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
    [`comfy-server:${row.id}`],
  );
  if (!lock.rows[0]?.locked) throw new Error("Worker is currently reserved by another application render");
  lockHeld = true;
  lockedServerId = row.id;

  await connection.query("UPDATE obtv_comfy_servers SET enabled=false WHERE id=$1", [row.id]);
  server = serverFromRow(row);

  const active = await connection.query(
    `SELECT
       (SELECT count(*)::int FROM obtv_generation_jobs
          WHERE comfy_server_id=$1 AND status=ANY($2::text[])) AS generation_jobs,
       (SELECT count(*)::int FROM obtv_image_studio_jobs
          WHERE comfy_server_id=$1 AND status=ANY($3::text[])) AS image_jobs`,
    [row.id, ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"], ["QUEUED", "RUNNING"]],
  );
  if (active.rows[0].generation_jobs || active.rows[0].image_jobs) {
    throw new Error(
      `Worker has assigned active DB jobs (generation=${active.rows[0].generation_jobs}, image=${active.rows[0].image_jobs}); nothing submitted`,
    );
  }
  const initialQueue = await readQueue();
  if (initialQueue.queue_running.length || initialQueue.queue_pending.length) {
    throw new Error(
      `Worker ComfyUI queue is not empty (running=${initialQueue.queue_running.length}, pending=${initialQueue.queue_pending.length}); nothing submitted`,
    );
  }

  for (const modelId of modelIds) {
    if (signal) throw new Error(`Received ${signal}`);
    if (!await checkLocalImageModel(modelId, server)) {
      throw new Error(`${modelId}: required node or model file is missing on this worker`);
    }
  }

  const outputDirectory = join("/tmp/obtv-image-worker-verification", row.id);
  await mkdir(outputDirectory, { recursive: true });
  for (const modelId of modelIds) {
    const submitted = await submitImageTask({
      modelId,
      operation: "generate",
      prompt: "A small red ceramic teapot on a plain studio table, product photograph",
      width: 512,
      height: 512,
      seed: 42,
      count: 1,
      referenceImages: [],
      server,
      clientId: `worker-verification-${randomUUID()}`,
    });
    currentTask = { ...submitted, server };
    const result = await waitForResult(currentTask);
    assert.equal(result.images?.length, 1, `${modelId}: expected exactly one output image`);
    const image = result.images[0];
    const outputPath = join(outputDirectory, `${modelId}.png`);
    await writeFile(outputPath, image.bytes);
    const dimensions = pngDimensions(image.bytes);
    assert.ok(dimensions, `${modelId}: output is empty or does not have a PNG signature (saved ${outputPath})`);
    assert.deepEqual(dimensions, { width: 512, height: 512 }, `${modelId}: wrong dimensions (saved ${outputPath})`);
    console.log(`PASS ${modelId} ${dimensions.width}x${dimensions.height} ${basename(outputPath)}`);
    currentTask = undefined;
  }
} catch (error) {
  if (currentTask && !await cancelOwnTaskSafely()) leaveDisabled = true;
  process.exitCode = 1;
  console.error(`FAIL ${safeError(error)}`);
} finally {
  if (connection && server && originalEnabled !== undefined && !leaveDisabled) {
    try {
      await connection.query("UPDATE obtv_comfy_servers SET enabled=$2 WHERE id=$1", [server.id, originalEnabled]);
    } catch (error) {
      leaveDisabled = true;
      console.error(`FAIL could not restore worker enabled flag: ${safeError(error)}`);
      process.exitCode = 1;
    }
  }
  if (leaveDisabled && server) {
    console.error(
      `SAFETY: worker ${server.id} was left disabled because this script's task state is uncertain. Verify its ComfyUI queue, then restore enabled=${originalEnabled} manually.`,
    );
  }
  if (connection && lockHeld && lockedServerId) {
    await connection.query("SELECT pg_advisory_unlock(hashtext($1))", [`comfy-server:${lockedServerId}`]).catch(() => {});
  }
  connection?.release();
  await pool.end().catch(() => {});
  await rm(buildDirectory, { recursive: true, force: true }).catch(() => {});
}
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gzipSync } from "node:zlib";

const serverScript = fileURLToPath(new URL("./static-server.mjs", import.meta.url));
const fixture = "<!doctype html><title>Static proxy regression fixture</title>";
const binary = Buffer.from(Array.from({ length: 128 * 1024 }, (_, i) => i % 256));
const compressed = gzipSync(binary);
const testOptions = { timeout: 15_000 };

// Opt-in comparison against the committed, pre-fix script. Normal runs always
// copy the working script verbatim and use PORT=0.
const baseline = process.env.STATIC_SERVER_TEST_BASELINE === "1";
const baselineSource = baseline
  ? execFileSync("git", ["show", "HEAD:deployment/static-server.mjs"], {
    cwd: path.dirname(serverScript),
    encoding: "utf8",
  })
  : null;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function deadline(promise, label, milliseconds = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function createProxy(t, handler) {
  const directory = await mkdtemp(path.join(tmpdir(), "static-server-test-"));
  const upstream = http.createServer(handler);
  let child;
  let output = "";
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      try {
        await deadline(exited, "child shutdown", 2_000);
      } catch {
        child.kill("SIGKILL");
        await deadline(exited, "forced child shutdown", 2_000);
      }
    }
    upstream.closeAllConnections();
    if (upstream.listening) {
      await new Promise((resolve) => upstream.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });

  const upstreamPort = await listen(upstream);
  await mkdir(path.join(directory, "public"));
  await writeFile(path.join(directory, "public", "index.html"), fixture);
  const script = path.join(directory, "static-server.mjs");
  if (baseline) await writeFile(script, baselineSource);
  else await copyFile(serverScript, script);

  let requestedPort = 0;
  if (baseline) {
    // The old script logs "0", not its bound ephemeral port. Reserve an
    // ephemeral port just for the baseline; do not alter the original script.
    const reservation = http.createServer();
    requestedPort = await listen(reservation);
    await new Promise((resolve) => reservation.close(resolve));
  }

  child = spawn(process.execPath, [script], {
    cwd: directory,
    env: {
      ...process.env,
      PORT: String(requestedPort),
      API_PROXY_ORIGIN: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const started = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/Static web server listening on port (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`Server exited before listening (${code ?? signal}): ${output}`));
    });
  });
  const port = await deadline(started, "server listening");
  assert.ok(port > 0, `Expected an actual bound port, received ${port}: ${output}`);
  return {
    port,
    child,
    output: () => output,
    async healthy() {
      const result = await collect(port, "/");
      assert.equal(child.exitCode, null, output);
      assert.equal(child.signalCode, null, output);
      assert.equal(result.status, 200, output);
      assert.equal(result.complete, true, output);
      assert.equal(result.body.toString(), fixture, output);
    },
  };
}

async function collect(port, url, { method = "GET", headers = {}, onChunk } = {}) {
  let request;
  const result = new Promise((resolve) => {
    let response;
    const chunks = [];
    let error;
    request = http.request({
      hostname: "127.0.0.1", port, path: url, method, headers, agent: false,
    }, (incoming) => {
      response = incoming;
      incoming.on("data", (chunk) => {
        chunks.push(chunk);
        onChunk?.(chunk);
      });
      incoming.on("error", (cause) => { error = cause; });
      incoming.on("close", () => resolve({
        status: incoming.statusCode,
        headers: incoming.headers,
        body: Buffer.concat(chunks),
        complete: incoming.complete,
        error,
      }));
    });
    request.on("error", (cause) => {
      if (!response) resolve({ body: Buffer.alloc(0), complete: false, error: cause });
    });
    request.end();
  });
  try {
    return await deadline(result, `${method} ${url}`);
  } finally {
    request.destroy();
  }
}

test("proxy transfers a full binary response without changing bytes or headers", testOptions, async (t) => {
  const proxy = await createProxy(t, (request, response) => {
    assert.equal(request.url, "/api/media/video.mp4?download=1");
    response.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": binary.length,
      "accept-ranges": "bytes",
    });
    response.write(binary.subarray(0, 8192));
    response.end(binary.subarray(8192));
  });
  const result = await collect(proxy.port, "/api/media/video.mp4?download=1");
  assert.equal(result.status, 200);
  assert.equal(result.complete, true);
  assert.equal(result.headers["content-type"], "video/mp4");
  assert.equal(result.headers["content-length"], String(binary.length));
  assert.equal(result.headers["accept-ranges"], "bytes");
  assert.deepEqual(result.body, binary);
  await proxy.healthy();
});

test("proxy preserves a 206 byte-range response and forwards the Range header", testOptions, async (t) => {
  const range = binary.subarray(1000, 4096);
  const proxy = await createProxy(t, (request, response) => {
    assert.equal(request.headers.range, "bytes=1000-4095");
    response.writeHead(206, {
      "content-type": "video/mp4",
      "content-length": range.length,
      "content-range": `bytes 1000-4095/${binary.length}`,
      "accept-ranges": "bytes",
    });
    response.end(range);
  });
  const result = await collect(proxy.port, "/api/media/video.mp4", {
    headers: { range: "bytes=1000-4095" },
  });
  assert.equal(result.status, 206);
  assert.equal(result.complete, true);
  assert.equal(result.headers["content-length"], String(range.length));
  assert.equal(result.headers["content-range"], `bytes 1000-4095/${binary.length}`);
  assert.equal(result.headers["accept-ranges"], "bytes");
  assert.deepEqual(result.body, range);
  await proxy.healthy();
});

test("proxy HEAD has no body and preserves compressed representation metadata", testOptions, async (t) => {
  const proxy = await createProxy(t, (request, response) => {
    assert.equal(request.method, "HEAD");
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": compressed.length,
      "content-encoding": "gzip",
    });
    response.end();
  });
  const result = await collect(proxy.port, "/api/media/file", { method: "HEAD" });
  assert.equal(result.status, 200);
  assert.equal(result.complete, true);
  assert.equal(result.body.length, 0);
  assert.equal(result.headers["content-length"], String(compressed.length));
  assert.equal(result.headers["content-encoding"], "gzip");
  await proxy.healthy();
});

test("proxy strips gzip wire headers when fetch decodes the upstream body", testOptions, async (t) => {
  const proxy = await createProxy(t, (_request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": compressed.length,
      "content-encoding": "gzip",
      "x-upstream-marker": "compressed",
    });
    response.end(compressed);
  });
  // node:http intentionally does not decompress: this tests the actual wire
  // response, not a second client's transparent decoding.
  const result = await collect(proxy.port, "/api/media/compressed");
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-encoding"], undefined);
  assert.equal(result.headers["content-length"], undefined);
  assert.equal(result.headers["x-upstream-marker"], "compressed");
  assert.equal(result.complete, true);
  assert.deepEqual(result.body, binary);
  await proxy.healthy();
});

for (const kind of ["interrupted chunked", "truncated content-length"]) {
  test(`proxy survives ${kind} upstream data after sending headers`, testOptions, async (t) => {
    let upstreamResponse;
    const prefix = binary.subarray(0, 4096);
    const proxy = await createProxy(t, (_request, response) => {
      upstreamResponse = response;
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        ...(kind === "truncated content-length"
          ? { "content-length": binary.length }
          : { "transfer-encoding": "chunked" }),
      });
      response.write(prefix);
    });
    const result = await collect(proxy.port, "/api/media/interrupted", {
      // Trigger the failure only after the downstream has received bytes,
      // avoiding a race between headers and the upstream disconnect.
      onChunk: () => upstreamResponse.destroy(),
    });
    assert.equal(result.status, 200, proxy.output());
    if (kind === "truncated content-length") {
      assert.equal(result.complete, false, "A short fixed-length body must not appear successful");
    }
    // Fetch versions differ on treating EOF between chunks as an error. Both
    // paths must preserve the received bytes and leave the proxy alive.
    assert.deepEqual(result.body, prefix);
    await proxy.healthy();
  });
}

test("proxy returns 502 when upstream disconnects before sending headers", testOptions, async (t) => {
  const proxy = await createProxy(t, (request) => {
    request.socket.destroy();
  });
  const result = await collect(proxy.port, "/api/unavailable");
  assert.equal(result.status, 502);
  assert.equal(result.complete, true);
  assert.match(result.headers["content-type"], /^text\/plain/);
  assert.equal(result.body.toString(), "API proxy unavailable");
  await proxy.healthy();
});

for (const phase of ["before headers", "during the response body"]) {
  test(`client abort ${phase} cancels upstream and leaves the process healthy`, testOptions, async (t) => {
    const received = deferred();
    const closed = deferred();
    const proxy = await createProxy(t, (_request, response) => {
      response.on("close", () => closed.resolve());
      received.resolve();
      if (phase === "during the response body") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.write(binary.subarray(0, 4096));
      }
      // Keep upstream open indefinitely. Its close event must come from
      // downstream cancellation, not a scheduled upstream end or test cleanup.
    });
    const gotChunk = deferred();
    const request = http.get({
      hostname: "127.0.0.1", port: proxy.port, path: "/api/media/slow", agent: false,
    }, (response) => {
      response.on("error", () => {});
      response.once("data", () => gotChunk.resolve());
    });
    request.on("error", () => {});
    t.after(() => request.destroy());
    await deadline(received.promise, "upstream receives request");
    if (phase === "during the response body") {
      await deadline(gotChunk.promise, "downstream receives first chunk");
    }
    // events.once(request, "close") rejects on the expected ECONNRESET for
    // pre-header aborts; the assertion is about close, not that expected error.
    const disconnected = new Promise((resolve) => request.once("close", resolve));
    request.destroy();
    await deadline(disconnected, "downstream disconnect");
    await deadline(closed.promise, "upstream cancellation");
    await proxy.healthy();
  });
}
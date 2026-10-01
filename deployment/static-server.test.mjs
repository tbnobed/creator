import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

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

async function createProxy(t, handler, { trustProxy = false } = {}) {
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
      TRUST_PROXY: String(trustProxy),
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

async function collect(port, url, { method = "GET", headers = {}, body, onChunk } = {}) {
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
    request.end(body);
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

for (const [encoding, compress] of [
  ["gzip", gzipSync],
  ["deflate", deflateSync],
  ["br", brotliCompressSync],
]) {
  test(`proxy preserves raw ${encoding} bytes, encoding, and wire length`, testOptions, async (t) => {
    const wireBody = compress(binary);
    const proxy = await createProxy(t, (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": wireBody.length,
        "content-encoding": encoding,
        "x-upstream-marker": "compressed",
      });
      response.end(wireBody);
    });
    // node:http intentionally does not decompress: this tests the actual wire
    // response, not a second client's transparent decoding.
    const result = await collect(proxy.port, "/api/media/compressed");
    assert.equal(result.status, 200);
    assert.equal(result.headers["content-encoding"], encoding);
    assert.equal(result.headers["content-length"], String(wireBody.length));
    assert.equal(result.headers["x-upstream-marker"], "compressed");
    assert.equal(result.complete, true);
    assert.deepEqual(result.body, wireBody);
    await proxy.healthy();
  });
}

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
    assert.equal(result.complete, false, "An interrupted upstream body must not appear successful");
    // Preserve already-delivered bytes, but never mark a truncated response as
    // a successful complete transfer.
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

for (const framing of ["content-length", "chunked"]) {
  test(`proxy forwards a ${framing} POST upload body and request metadata`, testOptions, async (t) => {
    const received = deferred();
    const proxy = await createProxy(t, (request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        received.resolve({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks),
        });
        response.writeHead(201, { "content-type": "text/plain" });
        response.end("uploaded");
      });
    });
    const result = await collect(proxy.port, "/api/media/upload?name=video.bin", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-upload-marker": "binary-upload",
        ...(framing === "content-length" ? { "content-length": binary.length } : {}),
      },
      body: binary,
    });
    const upload = await deadline(received.promise, "upstream upload body");
    assert.equal(upload.method, "POST");
    assert.equal(upload.url, "/api/media/upload?name=video.bin");
    assert.equal(upload.headers["content-type"], "application/octet-stream");
    assert.equal(upload.headers["x-upload-marker"], "binary-upload");
    if (framing === "content-length") {
      assert.equal(upload.headers["content-length"], String(binary.length));
    }
    assert.deepEqual(upload.body, binary);
    assert.equal(result.status, 201);
    assert.equal(result.complete, true);
    assert.equal(result.body.toString(), "uploaded");
    await proxy.healthy();
  });
}

test("proxy keeps separate Set-Cookie values, including an Expires comma", testOptions, async (t) => {
  const cookies = [
    "session=abc; Path=/; HttpOnly; SameSite=Lax",
    "preference=dark; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
  ];
  const proxy = await createProxy(t, (_request, response) => {
    response.writeHead(200, { "set-cookie": cookies });
    response.end("cookies");
  });
  const result = await collect(proxy.port, "/api/session");
  assert.equal(result.status, 200);
  assert.equal(result.complete, true);
  assert.deepEqual(result.headers["set-cookie"], cookies);
  assert.equal(result.body.toString(), "cookies");
  await proxy.healthy();
});

test("proxy strips hop-by-hop and Connection-nominated headers in both directions", testOptions, async (t) => {
  const received = deferred();
  const proxy = await createProxy(t, (request, response) => {
    received.resolve(request.headers);
    response.writeHead(200, {
      "content-length": 2,
      "connection": "close, x-response-private",
      "keep-alive": "timeout=999",
      "proxy-connection": "keep-alive",
      "proxy-authenticate": 'Basic realm="upstream"',
      "te": "trailers",
      "upgrade": "websocket",
      "x-response-private": "must-not-leak",
      "x-response-public": "preserved",
    });
    response.end("ok");
  });
  const result = await collect(proxy.port, "/api/headers", {
    headers: {
      "connection": "keep-alive, x-request-private",
      "keep-alive": "timeout=999",
      "proxy-connection": "keep-alive",
      "proxy-authorization": "Basic dGVzdDp0ZXN0",
      "te": "trailers",
      "upgrade": "websocket",
      "x-request-private": "must-not-leak",
      "x-request-public": "preserved",
    },
  });
  const upstreamHeaders = await deadline(received.promise, "upstream request headers");
  for (const name of ["keep-alive", "proxy-connection", "proxy-authorization", "te", "upgrade", "x-request-private"]) {
    assert.equal(upstreamHeaders[name], undefined, `Request header ${name} must not reach upstream`);
  }
  assert.doesNotMatch(upstreamHeaders.connection ?? "", /x-request-private/i);
  assert.equal(upstreamHeaders["x-request-public"], "preserved");
  assert.equal(result.status, 200);
  assert.equal(result.complete, true);
  assert.equal(result.body.toString(), "ok");
  for (const name of ["proxy-connection", "proxy-authenticate", "te", "upgrade", "x-response-private"]) {
    assert.equal(result.headers[name], undefined, `Response header ${name} must not reach the client`);
  }
  // Node may generate Connection/Keep-Alive headers for the local socket; it
  // must never relay upstream's extension token, timeout, or stale framing.
  assert.doesNotMatch(result.headers.connection ?? "", /x-response-private/i);
  assert.doesNotMatch(result.headers["keep-alive"] ?? "", /timeout=999/);
  assert.equal(result.headers["transfer-encoding"], undefined);
  assert.equal(result.headers["content-length"], "2");
  assert.equal(result.headers["x-response-public"], "preserved");
  await proxy.healthy();
});

for (const trustProxy of [false, true]) {
  test(`proxy forwards the public host and ${trustProxy ? "trusts" : "ignores"} incoming forwarded proto/IP`, testOptions, async (t) => {
    const received = deferred();
    const publicHost = "studio.example.test:8443";
    const proxy = await createProxy(t, (request, response) => {
      received.resolve(request.headers);
      response.end("forwarded");
    }, { trustProxy });
    const result = await collect(proxy.port, "/api/forwarded", {
      headers: {
        "host": publicHost,
        "x-forwarded-host": "attacker.example.test",
        "x-forwarded-proto": "https, http",
        "x-forwarded-for": "198.51.100.10, 198.51.100.11",
      },
    });
    const headers = await deadline(received.promise, "forwarded request headers");
    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    assert.equal(headers.host, publicHost);
    assert.equal(headers["x-forwarded-host"], publicHost);
    assert.equal(headers["x-forwarded-proto"], trustProxy ? "https" : "http");
    if (trustProxy) assert.equal(headers["x-forwarded-for"], "198.51.100.10");
    else assert.match(headers["x-forwarded-for"], /^(?:::ffff:)?127\.0\.0\.1$/);
    await proxy.healthy();
  });
}

test("proxy backpressures large concurrent slow consumers with upstream Connection: close", testOptions, async (t) => {
  const chunk = binary.subarray(0, 64 * 1024);
  const chunkCount = 512;
  const totalBytes = chunk.length * chunkCount;
  const expectedHash = createHash("sha256");
  for (let i = 0; i < chunkCount; i++) expectedHash.update(chunk);
  const expectedDigest = expectedHash.digest("hex");
  const transfers = [];
  const upstreamErrors = [];
  const proxy = await createProxy(t, (_request, response) => {
    const state = { bytes: 0, backpressure: 0, finished: false };
    transfers.push(state);
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": totalBytes,
      "connection": "close",
    });
    // Respect the producer's own backpressure too: do not hide proxy buffering
    // behind an upstream that eagerly queues the entire fixture.
    void (async () => {
      for (let i = 0; i < chunkCount; i++) {
        const writable = response.write(chunk);
        state.bytes += chunk.length;
        if (!writable) {
          state.backpressure++;
          await once(response, "drain");
        }
      }
      state.finished = true;
      response.end();
    })().catch((error) => {
      upstreamErrors.push(error);
      response.destroy();
    });
  });

  const consumers = Array.from({ length: 3 }, (_, index) => {
    const ready = deferred();
    let incoming;
    let gated = true;
    let timer;
    const request = http.get({
      hostname: "127.0.0.1", port: proxy.port,
      path: `/api/media/large-${index}.bin`, agent: false,
    });
    t.after(() => {
      clearTimeout(timer);
      request.destroy();
      incoming?.destroy();
    });
    const done = new Promise((resolve) => {
      let error;
      request.on("response", (response) => {
        incoming = response;
        let bytes = 0;
        const hash = createHash("sha256");
        response.on("data", (data) => {
          bytes += data.length;
          hash.update(data);
          response.pause();
          if (gated) ready.resolve();
          else timer = setTimeout(() => response.resume(), 2);
        });
        response.on("error", (cause) => { error = cause; });
        response.on("close", () => {
          clearTimeout(timer);
          resolve({
            status: response.statusCode,
            headers: response.headers,
            complete: response.complete,
            bytes,
            digest: hash.digest("hex"),
            error,
          });
        });
      });
      request.on("error", (cause) => {
        if (!incoming) resolve({ complete: false, error: cause });
      });
    });
    return {
      ready: ready.promise,
      done,
      release() {
        gated = false;
        incoming.resume();
      },
    };
  });

  await deadline(Promise.all(consumers.map((consumer) => consumer.ready)), "concurrent first bytes");
  // Leave every client paused long enough for bounded TCP/stream buffers to
  // fill. A proxy buffering whole bodies would let upstream finish here.
  await delay(250);
  assert.equal(transfers.length, consumers.length);
  for (const state of transfers) {
    assert.ok(state.backpressure > 0, "Upstream producer must observe backpressure");
    assert.ok(state.bytes < totalBytes, "Paused client must stall upstream before its entire body is consumed");
    assert.equal(state.finished, false);
  }
  await proxy.healthy();
  for (const consumer of consumers) consumer.release();
  const results = await deadline(
    Promise.all(consumers.map((consumer) => consumer.done)), "concurrent slow transfers", 10_000,
  );
  assert.deepEqual(upstreamErrors, []);
  for (const result of results) {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    assert.equal(result.headers["content-length"], String(totalBytes));
    assert.equal(result.bytes, totalBytes);
    assert.equal(result.digest, expectedDigest);
  }
  assert.ok(transfers.every((state) => state.finished));
  await proxy.healthy();
});
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT ?? 8080);
const apiProxyOrigin = process.env.API_PROXY_ORIGIN;
const trustUpstreamProxy = process.env.TRUST_PROXY === "true";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

function contentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function safePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const relative = decoded.replace(/^\/+/, "");
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

async function resolveFile(urlPath) {
  const candidate = safePath(urlPath);
  if (!candidate) return null;

  try {
    const info = await stat(candidate);
    if (info.isFile()) return candidate;
  } catch {
    // Fall through to the SPA entry point for client-side routes.
  }

  if (path.extname(candidate)) return null;
  return path.join(root, "index.html");
}

function proxyHeaders(headers) {
  // Connection may nominate additional hop-specific headers to remove.
  const excluded = new Set([
    "connection", "keep-alive", "transfer-encoding", "te", "trailer",
    "upgrade", "proxy-authenticate", "proxy-authorization",
    "proxy-connection",
    ...String(headers.connection ?? "").toLowerCase().split(",").map((name) => name.trim()),
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) =>
    value !== undefined && !excluded.has(name.toLowerCase())));
}

const server = http.createServer(async (request, response) => {
  const requestPath = (request.url ?? "/").split("?", 1)[0];
  if ((requestPath === "/api" || requestPath.startsWith("/api/")) && apiProxyOrigin) {
    const controller = new AbortController();
    const cancelUpstream = () => {
      if (!response.writableFinished) controller.abort();
    };
    request.on("aborted", cancelUpstream);
    request.on("error", cancelUpstream);
    response.on("close", cancelUpstream);
    try {
      const target = new URL(request.url ?? "/api", apiProxyOrigin);
      const headers = proxyHeaders(request.headers);
      for (const name of ["host", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]) {
        delete headers[name];
      }
      const publicHost = request.headers.host;
      if (publicHost) {
        headers.host = publicHost;
        headers["x-forwarded-host"] = publicHost;
      }
      const incomingForwardedFor = request.headers["x-forwarded-for"];
      const trustedForwardedFor = Array.isArray(incomingForwardedFor)
        ? incomingForwardedFor[0]
        : incomingForwardedFor?.split(",", 1)[0]?.trim();
      const clientIp = trustUpstreamProxy && trustedForwardedFor
        ? trustedForwardedFor
        : request.socket.remoteAddress;
      if (clientIp) headers["x-forwarded-for"] = clientIp;
      const incomingForwardedProto = request.headers["x-forwarded-proto"];
      const trustedForwardedProto = Array.isArray(incomingForwardedProto)
        ? incomingForwardedProto[0]
        : incomingForwardedProto?.split(",", 1)[0]?.trim();
      headers["x-forwarded-proto"] = trustUpstreamProxy && trustedForwardedProto
          ? trustedForwardedProto
          : request.socket.encrypted ? "https" : "http";
      if (!["http:", "https:"].includes(target.protocol)) {
        throw new Error("API proxy origin must use HTTP or HTTPS");
      }
      // Do not use fetch/Undici here. Its parser can assert outside promise
      // error handling when a backpressured media socket ends (Node 24).
      // Native HTTP streams preserve wire bytes, compression, and Set-Cookie.
      const transport = target.protocol === "https:" ? https : http;
      await new Promise((resolve, reject) => {
        const outgoing = transport.request(target, {
          method: request.method,
          headers,
          signal: controller.signal,
          // Isolate transfers from upstream idle/keep-alive socket races.
          agent: false,
        }, (upstream) => {
          try {
            response.writeHead(upstream.statusCode ?? 502, proxyHeaders(upstream.headers));
            pipeline(upstream, response).then(resolve, reject);
          } catch (error) {
            upstream.destroy();
            reject(error);
          }
        });
        outgoing.on("error", reject);
        // Preserve streaming uploads and backpressure without buffering files.
        request.pipe(outgoing);
      });
    } catch (error) {
      const clientCancellation = controller.signal.aborted &&
        (error?.name === "AbortError" || error?.code === "ERR_STREAM_PREMATURE_CLOSE");
      if (!clientCancellation) console.error("API proxy request failed", error);
      if (!response.destroyed) {
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          response.end("API proxy unavailable");
        }
      }
    } finally {
      request.off("aborted", cancelUpstream);
      request.off("error", cancelUpstream);
      response.off("close", cancelUpstream);
    }
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const filePath = await resolveFile(requestPath);
  if (!filePath) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    const info = await stat(filePath);
    response.writeHead(200, {
      "cache-control": path.basename(filePath) === "index.html"
        ? "no-cache"
        : "public, max-age=31536000, immutable",
      "content-length": info.size,
      "content-type": contentType(filePath),
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      await pipeline(createReadStream(filePath), response);
    }
  } catch {
    if (!response.destroyed) {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end("Internal server error");
      }
    }
  }
});

server.listen(port, "0.0.0.0", () => {
  console.info(`Static web server listening on port ${server.address().port}`);
});
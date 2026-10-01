import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
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

const server = http.createServer(async (request, response) => {
  const requestPath = (request.url ?? "/").split("?", 1)[0];
  if ((requestPath === "/api" || requestPath.startsWith("/api/")) && apiProxyOrigin) {
    const controller = new AbortController();
    const cancelUpstream = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.on("close", cancelUpstream);
    try {
      const target = new URL(request.url ?? "/api", apiProxyOrigin);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || ["host", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].includes(name)) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const publicHost = request.headers.host;
      if (publicHost) {
        headers.set("host", publicHost);
        headers.set("x-forwarded-host", publicHost);
      }
      const incomingForwardedFor = request.headers["x-forwarded-for"];
      const trustedForwardedFor = Array.isArray(incomingForwardedFor)
        ? incomingForwardedFor[0]
        : incomingForwardedFor?.split(",", 1)[0]?.trim();
      const clientIp = trustUpstreamProxy && trustedForwardedFor
        ? trustedForwardedFor
        : request.socket.remoteAddress;
      if (clientIp) headers.set("x-forwarded-for", clientIp);
      const incomingForwardedProto = request.headers["x-forwarded-proto"];
      const trustedForwardedProto = Array.isArray(incomingForwardedProto)
        ? incomingForwardedProto[0]
        : incomingForwardedProto?.split(",", 1)[0]?.trim();
      headers.set(
        "x-forwarded-proto",
        trustUpstreamProxy && trustedForwardedProto
          ? trustedForwardedProto
          : request.socket.encrypted ? "https" : "http",
      );
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method ?? "GET") ? undefined : request,
        duplex: "half",
        signal: controller.signal,
      });
      const responseHeaders = Object.fromEntries(
        [...upstream.headers].filter(([name]) => !["connection", "keep-alive", "transfer-encoding"].includes(name.toLowerCase())),
      );
      // Fetch decodes these encodings, but preserves the upstream wire headers.
      // Forwarding the compressed length/encoding would corrupt the response.
      const encoding = upstream.headers.get("content-encoding");
      if (upstream.body && encoding &&
          encoding.split(",").every((value) => ["gzip", "deflate", "br"].includes(value.trim().toLowerCase()))) {
        delete responseHeaders["content-encoding"];
        delete responseHeaders["content-length"];
      }
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        // Await stream failures: an unhandled Readable error kills the web
        // process and drops every concurrent gallery/video request.
        await pipeline(Readable.fromWeb(upstream.body), response);
      } else {
        response.end();
      }
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
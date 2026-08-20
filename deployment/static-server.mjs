import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT ?? 8080);
const apiProxyOrigin = process.env.API_PROXY_ORIGIN;

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
    try {
      const target = new URL(request.url ?? "/api", apiProxyOrigin);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || name === "host") continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method ?? "GET") ? undefined : request,
        duplex: "half",
      });
      const responseHeaders = Object.fromEntries(
        [...upstream.headers].filter(([name]) => !["connection", "keep-alive", "transfer-encoding"].includes(name.toLowerCase())),
      );
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        Readable.fromWeb(upstream.body).pipe(response);
      } else {
        response.end();
      }
    } catch (error) {
      console.error("API proxy request failed", error);
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("API proxy unavailable");
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
      createReadStream(filePath).pipe(response);
    }
  } catch {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Internal server error");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.info(`Static web server listening on port ${port}`);
});
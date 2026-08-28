import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Router, type IRouter, type Request, type Response } from "express";
import { mediaStorage } from "../lib/storage-service";

const router: IRouter = Router();

function contentType(key: string): string {
  switch (path.extname(key).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

async function serveMedia(req: Request, res: Response): Promise<void> {
  const raw = Array.isArray(req.params.key) ? req.params.key.join("/") : req.params.key;
  if (!raw) {
    res.status(400).json({ error: "Media key is required" });
    return;
  }

  try {
    const filePath = mediaStorage.resolvePath(raw);
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile() || fileInfo.size === 0) {
      res.status(404).json({ error: "Media not found" });
      return;
    }

    const headers: Record<string, string> = {
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(fileInfo.size),
      "content-type": contentType(raw),
    };

    let start = 0;
    let end = fileInfo.size - 1;
    let status = 200;
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (!match || (!match[1] && !match[2])) {
        res.status(416).set("content-range", `bytes */${fileInfo.size}`).end();
        return;
      }

      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : end;
      } else {
        const suffixLength = Number(match[2]);
        start = Math.max(0, fileInfo.size - suffixLength);
      }

      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= fileInfo.size ||
        end < start
      ) {
        res.status(416).set("content-range", `bytes */${fileInfo.size}`).end();
        return;
      }

      end = Math.min(end, fileInfo.size - 1);
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${fileInfo.size}`;
      headers["content-length"] = String(end - start + 1);
    }

    res.writeHead(status, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = createReadStream(filePath, { start, end });
    stream.on("error", (error) => {
      if (!res.headersSent) {
        res.status(404).json({ error: "Media not found" });
      } else {
        res.destroy(error);
      }
    });
    stream.pipe(res);
  } catch {
    res.status(400).json({ error: "Invalid media path" });
  }
}

router.get("/media/{*key}", serveMedia);
router.head("/media/{*key}", serveMedia);

export default router;
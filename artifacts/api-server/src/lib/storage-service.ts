import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.env.OBTV_MEDIA_ROOT ?? "data/obtv-media");

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm"]);
const MAX_REFERENCE_VIDEO_BYTES = 250 * 1024 * 1024;
const previewJobs = new Map<string, Promise<string>>();
const PREVIEW_CONCURRENCY = 2;
const PREVIEW_TIMEOUT_MS = 30_000;
const MAX_FFMPEG_ERROR_BYTES = 8 * 1024;
const previewWaiters: Array<() => void> = [];
let activePreviewJobs = 0;

async function acquirePreviewSlot(): Promise<void> {
  if (activePreviewJobs < PREVIEW_CONCURRENCY) {
    activePreviewJobs += 1;
    return;
  }
  await new Promise<void>((resolve) => previewWaiters.push(resolve));
}

function releasePreviewSlot(): void {
  const next = previewWaiters.shift();
  if (next) next();
  else activePreviewJobs = Math.max(0, activePreviewJobs - 1);
}

function safeExtension(originalName: string, mimeType: string): string {
  const supplied = path.extname(originalName).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(supplied)) return supplied;
  return mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : ".jpg";
}

function safeVideoExtension(originalName: string, mimeType: string): string {
  const supplied = path.extname(originalName).toLowerCase();
  if ([".mp4", ".webm"].includes(supplied)) return supplied;
  return mimeType === "video/webm" ? ".webm" : ".mp4";
}

function resolveKey(key: string): string {
  const normalized = key.replaceAll("\\", "/");
  if (!/^[a-z0-9/_-]+\.(jpg|jpeg|png|webp|mp4|webm)$/i.test(normalized)) {
    throw new Error("Invalid media storage key");
  }
  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Invalid media storage key");
  return resolved;
}

export class LocalMediaStorage {
  async storeImage(
    originalName: string,
    mimeType: string,
    bytes: Buffer,
    category: "characters" | "settings",
  ): Promise<string> {
    if (!IMAGE_MIME_TYPES.has(mimeType)) throw new Error("Only JPG, PNG, and WebP images are allowed");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("Image must be between 1 byte and 15 MB");
    }
    const key = `${category}/${randomUUID()}${safeExtension(originalName, mimeType)}`;
    const destination = resolveKey(key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
    return key;
  }

  async readBuffer(key: string): Promise<Buffer> {
    return readFile(resolveKey(key));
  }

  async storeReferenceVideo(
    originalName: string,
    mimeType: string,
    bytes: Buffer,
  ): Promise<string> {
    if (!VIDEO_MIME_TYPES.has(mimeType)) throw new Error("Only MP4 and WebM reference videos are allowed");
    if (bytes.length === 0 || bytes.length > MAX_REFERENCE_VIDEO_BYTES) {
      throw new Error("Reference video must be between 1 byte and 250 MB");
    }
    const key = `reference-videos/${randomUUID()}${safeVideoExtension(originalName, mimeType)}`;
    const destination = resolveKey(key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
    return key;
  }

  async readReferenceVideo(key: string): Promise<{ name: string; mimeType: "video/mp4" | "video/webm"; bytes: Buffer }> {
    if (!key.startsWith("reference-videos/")) throw new Error("Invalid reference video");
    const mimeType = key.endsWith(".webm") ? "video/webm" : key.endsWith(".mp4") ? "video/mp4" : null;
    if (!mimeType) throw new Error("Invalid reference video");
    return {
      name: path.basename(key),
      mimeType,
      bytes: await readFile(resolveKey(key)),
    };
  }

  async listReferenceVideos(): Promise<Array<{ storageKey: string; name: string; mimeType: "video/mp4" | "video/webm"; size: number; createdAt: string }>> {
    const directory = path.join(root, "reference-videos");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const videos = await Promise.all(entries
      .filter((entry) => entry.isFile() && /\.(mp4|webm)$/i.test(entry.name))
      .map(async (entry) => {
        const storageKey = `reference-videos/${entry.name}`;
        const fileInfo = await stat(path.join(directory, entry.name));
        const mimeType = entry.name.toLowerCase().endsWith(".webm") ? "video/webm" as const : "video/mp4" as const;
        return {
          storageKey,
          name: entry.name,
          mimeType,
          size: fileInfo.size,
          createdAt: fileInfo.birthtime.toISOString(),
        };
      }));

    return videos.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async storeOutput(
    originalName: string,
    mimeType: "video/mp4" | "video/webm",
    bytes: Buffer,
  ): Promise<string> {
    const extension = mimeType === "video/webm" ? ".webm" : ".mp4";
    if (bytes.length === 0) throw new Error("Generated output is empty");
    const key = `generations/${randomUUID()}${extension}`;
    const destination = resolveKey(key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
    return key;
  }

  resolvePath(key: string): string {
    return resolveKey(key);
  }

  async videoPreviewPath(key: string): Promise<string> {
    const normalized = key.replaceAll("\\", "/");
    if (!/^(generations|reference-videos)\/[a-z0-9/_-]+\.(mp4|webm)$/i.test(normalized)) {
      throw new Error("Invalid video preview key");
    }
    const source = resolveKey(normalized);
    await stat(source);

    const previewDirectory = path.join(root, "previews");
    const previewName = `${createHash("sha256").update(normalized).digest("hex")}.jpg`;
    const destination = path.join(previewDirectory, previewName);
    try {
      const existing = await stat(destination);
      if (existing.isFile() && existing.size > 0) return destination;
    } catch {
      // Generate and cache the preview below.
    }

    const existingJob = previewJobs.get(destination);
    if (existingJob) return existingJob;

    const job = (async () => {
      await mkdir(previewDirectory, { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp.jpg`;
      await acquirePreviewSlot();
      try {
        await new Promise<void>((resolve, reject) => {
          const process = spawn("ffmpeg", [
            "-v", "error",
            "-ss", "0.1",
            "-i", source,
            "-frames:v", "1",
            "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
            "-q:v", "3",
            "-y", temporary,
          ]);
          let stderr = "";
          let settled = false;
          let timedOut = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error) reject(error);
            else resolve();
          };
          const timeout = setTimeout(() => {
            timedOut = true;
            process.kill("SIGKILL");
          }, PREVIEW_TIMEOUT_MS);
          process.stderr.on("data", (chunk) => {
            if (stderr.length < MAX_FFMPEG_ERROR_BYTES) {
              stderr += String(chunk).slice(0, MAX_FFMPEG_ERROR_BYTES - stderr.length);
            }
          });
          process.on("error", (error) => finish(error));
          process.on("close", (code) => {
            if (timedOut) finish(new Error("Video preview generation timed out"));
            else if (code === 0) finish();
            else finish(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
          });
        });
        await rename(temporary, destination);
        return destination;
      } finally {
        releasePreviewSlot();
        await unlink(temporary).catch(() => undefined);
      }
    })();

    previewJobs.set(destination, job);
    try {
      return await job;
    } finally {
      previewJobs.delete(destination);
    }
  }

  async deleteOutput(key: string): Promise<void> {
    await unlink(resolveKey(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  stream(key: string) {
    return createReadStream(resolveKey(key));
  }
}

export const mediaStorage = new LocalMediaStorage();
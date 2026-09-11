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
const VOICE_MIME_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
  "audio/ogg",
]);
const MAX_VOICE_BYTES = 30 * 1024 * 1024;
const previewJobs = new Map<string, Promise<string>>();
const PREVIEW_CONCURRENCY = 2;
const PREVIEW_TIMEOUT_MS = 30_000;
const MAX_FFMPEG_ERROR_BYTES = 8 * 1024;
const previewWaiters: Array<() => void> = [];
let activePreviewJobs = 0;

function tenantKey(tenantId: string, key: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error("Invalid tenant");
  return `tenants/${tenantId}/${key}`;
}

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

function safeVoiceExtension(originalName: string, mimeType: string): string {
  const supplied = path.extname(originalName).toLowerCase();
  if ([".wav", ".mp3", ".m4a", ".webm", ".ogg"].includes(supplied)) return supplied;
  if (mimeType === "audio/mpeg") return ".mp3";
  if (mimeType === "audio/mp4" || mimeType === "audio/x-m4a") return ".m4a";
  if (mimeType === "audio/webm") return ".webm";
  if (mimeType === "audio/ogg") return ".ogg";
  return ".wav";
}

async function runMediaCommand(command: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_FFMPEG_ERROR_BYTES) {
        stderr += String(chunk).slice(0, MAX_FFMPEG_ERROR_BYTES - stderr.length);
      }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (timedOut) finish(new Error(`${command} timed out`));
      else if (code === 0) finish();
      else finish(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

function resolveKey(key: string): string {
  if (key.includes("\\") || !/^[a-z0-9/_-]+\.(jpg|jpeg|png|webp|mp4|webm|wav)$/i.test(key)) {
    throw new Error("Invalid media storage key");
  }
  const resolved = path.resolve(root, key);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Invalid media storage key");
  return resolved;
}

export class LocalMediaStorage {
  async storeImage(
    originalName: string,
    mimeType: string,
    bytes: Buffer,
    category: "characters" | "settings",
    tenantId: string,
  ): Promise<string> {
    if (!IMAGE_MIME_TYPES.has(mimeType)) throw new Error("Only JPG, PNG, and WebP images are allowed");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("Image must be between 1 byte and 15 MB");
    }
    const key = tenantKey(tenantId, `${category}/${randomUUID()}${safeExtension(originalName, mimeType)}`);
    const destination = resolveKey(key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
    return key;
  }

  async storeImageStudioImage(
    originalName: string,
    mimeType: string,
    bytes: Buffer,
    tenantId: string,
  ): Promise<string> {
    if (!IMAGE_MIME_TYPES.has(mimeType)) throw new Error("Only JPEG, PNG, and WebP images are allowed");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("Image must be between 1 byte and 15 MB");
    }
    const key = tenantKey(
      tenantId,
      `image-studio/${randomUUID()}${safeExtension(originalName, mimeType)}`,
    );
    const destination = resolveKey(key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
    return key;
  }

  /** A continuity still is copied out of Image Studio so deleting its source asset
   * can never invalidate an approved long-form reference. */
  async storeContinuityStill(
    originalName: string,
    mimeType: string,
    bytes: Buffer,
    tenantId: string,
  ): Promise<string> {
    if (!IMAGE_MIME_TYPES.has(mimeType)) throw new Error("Only JPEG, PNG, and WebP images are allowed");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("Image must be between 1 byte and 15 MB");
    }
    const key = tenantKey(
      tenantId,
      `long-form-continuity/${randomUUID()}${safeExtension(originalName, mimeType)}`,
    );
    const destination = resolveKey(key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
    return key;
  }

  async readBuffer(key: string): Promise<Buffer> {
    return readFile(resolveKey(key));
  }

  async storeVoiceSample(
    originalName: string,
    mimeType: string,
    bytes: Buffer,
    tenantId: string,
  ): Promise<{ key: string; mimeType: "audio/wav"; durationSeconds: number }> {
    if (!VOICE_MIME_TYPES.has(mimeType)) {
      throw new Error("Use a WAV, MP3, M4A, WebM, or OGG voice recording");
    }
    if (bytes.length === 0 || bytes.length > MAX_VOICE_BYTES) {
      throw new Error("Voice recording must be between 1 byte and 30 MB");
    }

    const id = randomUUID();
    const source = path.join("/tmp", `obtv-voice-${id}${safeVoiceExtension(originalName, mimeType)}`);
    const key = tenantKey(tenantId, `voices/${id}.wav`);
    const destination = resolveKey(key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(source, bytes, { flag: "wx" });
    try {
      await runMediaCommand("ffmpeg", [
        "-v", "error",
        "-i", source,
        "-vn",
        "-ac", "1",
        "-ar", "24000",
        "-c:a", "pcm_s16le",
        "-y", destination,
      ]);
      const durationText = await runMediaCommand("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        destination,
      ]);
      const durationSeconds = Number(durationText.trim());
      if (!Number.isFinite(durationSeconds) || durationSeconds < 3 || durationSeconds > 30) {
        throw new Error("Voice recording must be between 3 and 30 seconds long");
      }
      return { key, mimeType: "audio/wav", durationSeconds };
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    } finally {
      await unlink(source).catch(() => undefined);
    }
  }

  async deleteVoiceSample(key: string): Promise<void> {
    if (!/^(?:tenants\/[0-9a-f-]{36}\/)?voices\/[a-z0-9_-]+\.wav$/i.test(key)) throw new Error("Invalid voice sample");
    await unlink(resolveKey(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async storeReferenceVideo(
    originalName: string,
    mimeType: string,
    bytes: Buffer,
    tenantId: string,
  ): Promise<string> {
    if (!VIDEO_MIME_TYPES.has(mimeType)) throw new Error("Only MP4 and WebM reference videos are allowed");
    if (bytes.length === 0 || bytes.length > MAX_REFERENCE_VIDEO_BYTES) {
      throw new Error("Reference video must be between 1 byte and 250 MB");
    }
    const key = tenantKey(tenantId, `reference-videos/${randomUUID()}${safeVideoExtension(originalName, mimeType)}`);
    const destination = resolveKey(key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
    return key;
  }

  async readReferenceVideo(key: string): Promise<{ name: string; mimeType: "video/mp4" | "video/webm"; bytes: Buffer }> {
    if (!/(?:^|\/)reference-videos\//.test(key)) throw new Error("Invalid reference video");
    const mimeType = key.endsWith(".webm") ? "video/webm" : key.endsWith(".mp4") ? "video/mp4" : null;
    if (!mimeType) throw new Error("Invalid reference video");
    return {
      name: path.basename(key),
      mimeType,
      bytes: await readFile(resolveKey(key)),
    };
  }

  async listReferenceVideos(tenantId: string, includeLegacy = false): Promise<Array<{ storageKey: string; name: string; mimeType: "video/mp4" | "video/webm"; size: number; createdAt: string }>> {
    const tenantPrefix = tenantKey(tenantId, "reference-videos");
    const prefixes = includeLegacy ? [tenantPrefix, "reference-videos"] : [tenantPrefix];
    const readPrefix = async (prefix: string) => {
      const directory = path.join(root, prefix);
      let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

      return Promise.all(entries
      .filter((entry) => entry.isFile() && /\.(mp4|webm)$/i.test(entry.name))
      .map(async (entry) => {
        const storageKey = `${prefix}/${entry.name}`;
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
    };
    const videos = (await Promise.all(prefixes.map(readPrefix))).flat();

    return videos.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async deleteReferenceVideo(key: string): Promise<boolean> {
    if (!/^(?:tenants\/[0-9a-f-]{36}\/)?reference-videos\/[a-z0-9/_-]+\.(mp4|webm)$/i.test(key)) {
      throw new Error("Invalid reference video");
    }
    try {
      await unlink(resolveKey(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async storeOutput(
    originalName: string,
    mimeType: "video/mp4" | "video/webm",
    bytes: Buffer,
    tenantId: string,
  ): Promise<string> {
    const extension = mimeType === "video/webm" ? ".webm" : ".mp4";
    if (bytes.length === 0) throw new Error("Generated output is empty");
    const key = tenantKey(tenantId, `generations/${randomUUID()}${extension}`);
    const destination = resolveKey(key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
    return key;
  }

  resolvePath(key: string): string {
    return resolveKey(key);
  }

  async videoPreviewPath(key: string, tenantId: string): Promise<string> {
    if (key.includes("\\") || !/^(?:tenants\/[0-9a-f-]{36}\/)?(generations|reference-videos)\/[a-z0-9/_-]+\.(mp4|webm)$/i.test(key)) {
      throw new Error("Invalid video preview key");
    }
    const source = resolveKey(key);
    await stat(source);

    const previewDirectory = path.join(root, tenantKey(tenantId, "previews"));
    const previewName = `${createHash("sha256").update(key).digest("hex")}.jpg`;
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

  async deleteImageStudioImage(key: string): Promise<void> {
    if (!/(?:^|\/)image-studio\/[a-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(key)) {
      throw new Error("Invalid Image Studio storage key");
    }
    await unlink(resolveKey(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  stream(key: string) {
    return createReadStream(resolveKey(key));
  }
}

export const mediaStorage = new LocalMediaStorage();
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const root = path.resolve(process.env.OBTV_MEDIA_ROOT ?? "data/obtv-media");

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm"]);
const MAX_REFERENCE_VIDEO_BYTES = 250 * 1024 * 1024;

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

  stream(key: string) {
    return createReadStream(resolveKey(key));
  }
}

export const mediaStorage = new LocalMediaStorage();
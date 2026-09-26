import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  characterAssetsTable, charactersTable, db, generationJobsTable, imageStudioAssetsTable,
  settingAssetsTable, settingsTable, videoLibraryStatesTable,
} from "@workspace/db";
import { mediaStorage } from "./storage-service";

export type MediaKind = "image" | "video" | "audio";
export type ReferenceRole = "referenceImage" | "firstFrame" | "lastFrame" | "referenceVideo" | "referenceAudio";
export type SourceType = "upload" | "generation" | "imageAsset" | "characterAsset" | "settingAsset" | "referenceVideo";
type LibraryItem = {
  sourceType: SourceType;
  sourceId: string;
  name: string;
  kind: MediaKind;
  mimeType: string;
  mediaUrl: string;
  previewUrl: string | null;
  createdAt: string;
};

export class ReferenceLibraryError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const mimeByExtension: Record<string, string> = {
  ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
};
const kindForMime = (mime: string): MediaKind | null =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : null;
const roleKind = (role: ReferenceRole): MediaKind =>
  role === "referenceVideo" ? "video" : role === "referenceAudio" ? "audio" : "image";

function entry(sourceType: SourceType, sourceId: string, name: string, key: string, mimeType: string, date: Date): LibraryItem {
  const kind = kindForMime(mimeType);
  if (!kind) throw new ReferenceLibraryError("Unsupported library media type", 415);
  return {
    sourceType, sourceId, name, kind, mimeType,
    mediaUrl: `/api/media/${key}`, previewUrl: kind === "video" && /\.(mp4|webm)$/i.test(key)
      ? `/api/media-preview/${key}` : kind === "image" ? `/api/media/${key}` : null,
    createdAt: date.toISOString(),
  };
}

async function filesIn(tenantId: string, directory: "generation-references" | "reference-videos") {
  // Build this path solely from the authenticated tenant and fixed directory name.
  const prefix = `tenants/${tenantId}/${directory}`;
  const dir = path.resolve(process.env.OBTV_MEDIA_ROOT ?? "data/obtv-media", prefix);
  let files;
  try { files = await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const allowed = directory === "generation-references"
    ? /^[0-9a-f-]{36}\.(jpg|png|webp|mp4|mov|mp3|wav)$/i
    : /^[0-9a-f-]{36}\.(mp4|webm)$/i;
  return Promise.all(files.filter((f) => f.isFile() && allowed.test(f.name)).map(async (f) => {
    const key = `${prefix}/${f.name}`;
    const mime = mimeByExtension[path.extname(f.name).toLowerCase()];
    const info = await stat(path.join(dir, f.name));
    return entry(directory === "generation-references" ? "upload" : "referenceVideo", f.name,
      f.name, key, mime, info.birthtime);
  }));
}

export async function listReferenceLibrary(tenantId: string, kind?: MediaKind, role?: ReferenceRole) {
  const owned = (key: string) => key.startsWith(`tenants/${tenantId}/`) && !key.includes("\\");
  const [uploads, referenceVideos, videos, images, characters, settings] = await Promise.all([
    filesIn(tenantId, "generation-references"),
    filesIn(tenantId, "reference-videos"),
    db.select({ id: generationJobsTable.id, title: generationJobsTable.title, key: generationJobsTable.outputStorageKey,
      mime: generationJobsTable.outputMimeType, createdAt: generationJobsTable.createdAt })
      .from(generationJobsTable)
      .leftJoin(videoLibraryStatesTable, and(
        eq(videoLibraryStatesTable.generationJobId, generationJobsTable.id),
        eq(videoLibraryStatesTable.tenantId, tenantId),
      ))
      .where(and(eq(generationJobsTable.tenantId, tenantId), eq(generationJobsTable.status, "COMPLETED"),
        isNull(videoLibraryStatesTable.deletedAt)))
      .orderBy(desc(generationJobsTable.createdAt)).limit(500),
    db.select().from(imageStudioAssetsTable).where(eq(imageStudioAssetsTable.tenantId, tenantId))
      .orderBy(desc(imageStudioAssetsTable.createdAt)).limit(500),
    db.select({ id: characterAssetsTable.id, name: characterAssetsTable.originalName,
      key: characterAssetsTable.storageKey, mime: characterAssetsTable.mimeType,
      createdAt: characterAssetsTable.createdAt })
      .from(characterAssetsTable).innerJoin(charactersTable, eq(characterAssetsTable.characterId, charactersTable.id))
      .where(eq(charactersTable.tenantId, tenantId)).limit(500),
    db.select({ id: settingAssetsTable.id, name: settingAssetsTable.originalName,
      key: settingAssetsTable.storageKey, mime: settingAssetsTable.mimeType,
      createdAt: settingAssetsTable.createdAt })
      .from(settingAssetsTable).innerJoin(settingsTable, eq(settingAssetsTable.settingId, settingsTable.id))
      .where(eq(settingsTable.tenantId, tenantId)).limit(500),
  ]);
  const items = [
    ...uploads, ...referenceVideos,
    ...videos.filter((v) => v.key && owned(v.key) && v.mime && kindForMime(v.mime))
      .map((v) => entry("generation", v.id, v.title, v.key!, v.mime!, v.createdAt)),
    ...images.filter((i) => owned(i.storageKey) && kindForMime(i.mimeType))
      .map((i) => entry("imageAsset", i.id, i.name, i.storageKey, i.mimeType, i.createdAt)),
    ...characters.filter((i) => owned(i.key) && kindForMime(i.mime))
      .map((i) => entry("characterAsset", i.id, i.name, i.key, i.mime, i.createdAt)),
    ...settings.filter((i) => owned(i.key) && kindForMime(i.mime))
      .map((i) => entry("settingAsset", i.id, i.name, i.key, i.mime, i.createdAt)),
  ];
  return items.filter((item) => (!kind || item.kind === kind) && (!role || item.kind === roleKind(role)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function importReference(
  tenantId: string, sourceType: SourceType, sourceId: string, role?: ReferenceRole,
) {
  // Look up exactly one tenant-owned source, independent of library listing limits.
  // Never accept a client-supplied path, URL, or storage key.
  let source: { key: string; mimeType: string } | null = null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (sourceType === "upload" || sourceType === "referenceVideo") {
    const directory = sourceType === "upload" ? "generation-references" : "reference-videos";
    const allowed = sourceType === "upload"
      ? /^[0-9a-f-]{36}\.(jpg|png|webp|mp4|mov|mp3|wav)$/i
      : /^[0-9a-f-]{36}\.(mp4|webm)$/i;
    if (allowed.test(sourceId) && uuid.test(path.parse(sourceId).name)) {
      source = {
        key: `tenants/${tenantId}/${directory}/${sourceId}`,
        mimeType: mimeByExtension[path.extname(sourceId).toLowerCase()],
      };
    }
  } else if (uuid.test(sourceId)) {
    if (sourceType === "generation") {
      const [row] = await db.select({ key: generationJobsTable.outputStorageKey, mime: generationJobsTable.outputMimeType })
        .from(generationJobsTable)
        .leftJoin(videoLibraryStatesTable, and(
          eq(videoLibraryStatesTable.generationJobId, generationJobsTable.id),
          eq(videoLibraryStatesTable.tenantId, tenantId),
        ))
        .where(and(eq(generationJobsTable.id, sourceId), eq(generationJobsTable.tenantId, tenantId),
          eq(generationJobsTable.status, "COMPLETED"), isNull(videoLibraryStatesTable.deletedAt))).limit(1);
      if (row?.key) source = { key: row.key, mimeType: row.mime ?? mimeByExtension[path.extname(row.key).toLowerCase()] };
    } else if (sourceType === "imageAsset") {
      const [row] = await db.select({ key: imageStudioAssetsTable.storageKey, mime: imageStudioAssetsTable.mimeType })
        .from(imageStudioAssetsTable)
        .where(and(eq(imageStudioAssetsTable.id, sourceId), eq(imageStudioAssetsTable.tenantId, tenantId))).limit(1);
      if (row) source = { key: row.key, mimeType: row.mime };
    } else if (sourceType === "characterAsset") {
      const [row] = await db.select({ key: characterAssetsTable.storageKey, mime: characterAssetsTable.mimeType })
        .from(characterAssetsTable).innerJoin(charactersTable, eq(characterAssetsTable.characterId, charactersTable.id))
        .where(and(eq(characterAssetsTable.id, sourceId), eq(charactersTable.tenantId, tenantId))).limit(1);
      if (row) source = { key: row.key, mimeType: row.mime };
    } else if (sourceType === "settingAsset") {
      const [row] = await db.select({ key: settingAssetsTable.storageKey, mime: settingAssetsTable.mimeType })
        .from(settingAssetsTable).innerJoin(settingsTable, eq(settingAssetsTable.settingId, settingsTable.id))
        .where(and(eq(settingAssetsTable.id, sourceId), eq(settingsTable.tenantId, tenantId))).limit(1);
      if (row) source = { key: row.key, mimeType: row.mime };
    }
  }
  if (!source || !source.key.startsWith(`tenants/${tenantId}/`) || source.key.includes("\\")) {
    throw new ReferenceLibraryError("Reference asset not found", 404);
  }
  const kind = kindForMime(source.mimeType);
  if (!kind) throw new ReferenceLibraryError("Unsupported reference media type", 415);
  if (role && kind !== roleKind(role)) throw new ReferenceLibraryError("Reference role requires a different media kind", 415);
  if (source.mimeType === "video/webm") {
    throw new ReferenceLibraryError("WebM cannot be imported as generation reference media; use MP4", 415);
  }
  const maxBytes = kind === "video" ? 200 * 1024 * 1024 : 30 * 1024 * 1024;
  let info;
  try { info = await stat(mediaStorage.resolvePath(source.key)); }
  catch { throw new ReferenceLibraryError("Reference media file not found", 404); }
  if (!info.isFile() || info.size < 1 || info.size > maxBytes) {
    throw new ReferenceLibraryError("Reference media exceeds upload limits or is empty", 413);
  }
  const bytes = await mediaStorage.readBuffer(source.key);
  const storageKey = await mediaStorage.storeGenerationReferenceMedia(source.mimeType, bytes, tenantId);
  return { storageKey, mediaUrl: `/api/media/${storageKey}`, mimeType: source.mimeType };
}
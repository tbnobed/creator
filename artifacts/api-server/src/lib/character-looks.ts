import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  characterAssetsTable,
  characterLookBatchesTable,
  charactersTable,
  db,
  imageStudioAssetsTable,
  type CharacterLookBatch,
  type CharacterLookSlot,
} from "@workspace/db";
import { createImageJob, getImageJob, ImageStudioRequestError } from "./image-studio-service";
import { getImageModel } from "./image-studio-models";
import { invalidateCharacterDossier } from "./character-dossier-service";
import { mediaStorage } from "./storage-service";
import { logger } from "./logger";

export const SHEET_VIEWS = [
  { view: "front", label: "full-body" },
  { view: "three-quarter", label: "three-quarter" },
  { view: "profile", label: "profile" },
  { view: "expressions", label: "expression" },
] as const;
const BACKOFF_BASE_MS = 2_500;
const BACKOFF_MAX_MS = 5 * 60_000;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Serialize every start/keep/retry for one character. Always taken before any row lock. */
async function lockCharacter(tx: Tx, characterId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`obtv:character-looks:${characterId}`}, 0))`);
}

/** Only an explicit, deterministic provider rejection is terminal. Anything else may have been accepted. */
export function isDeterministicRejection(error: unknown): boolean {
  if (!(error instanceof ImageStudioRequestError)) return false;
  return error.status >= 400 && error.status < 500 && ![408, 409, 425, 429].includes(error.status);
}
const WIDTH = 768;
const HEIGHT = 1024;

export class CharacterLookError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Injectable image job operations so tests never reach a GPU or a paid provider. */
export type LookJobDeps = {
  createJob: typeof createImageJob;
  getJob: typeof getImageJob;
  readBytes: (storageKey: string) => Promise<Buffer>;
  storeCharacterImage: (name: string, mimeType: string, bytes: Buffer, tenantId: string) => Promise<string>;
};
export const defaultLookDeps: LookJobDeps = {
  createJob: createImageJob,
  getJob: getImageJob,
  readBytes: (key) => mediaStorage.readBuffer(key),
  storeCharacterImage: (name, mime, bytes, tenantId) => mediaStorage.storeImage(name, mime, bytes, "characters", tenantId),
};

export type PresentedLookBatch = {
  id: string;
  kind: "PORTRAITS" | "SHEET";
  status: "ACTIVE" | "COMPLETED" | "FAILED";
  modelId: string;
  modelName: string;
  provider: "LOCAL" | "CLOUD";
  prompt: string;
  selectedAssetId: string | null;
  createdAt: string;
  slots: Array<{ index: number; view: string | null; status: CharacterLookSlot["status"]; assetId: string | null; mediaUrl: string | null; error: string | null }>;
};

function present(batch: CharacterLookBatch | undefined): PresentedLookBatch | null {
  if (!batch) return null;
  const model = getImageModel(batch.modelId);
  return {
    id: batch.id, kind: batch.kind, status: batch.status, modelId: batch.modelId,
    modelName: model?.name ?? batch.modelId, provider: model?.provider ?? "LOCAL",
    prompt: batch.prompt, selectedAssetId: batch.selectedAssetId, createdAt: batch.createdAt.toISOString(),
    slots: batch.slots.map((s) => ({
      index: s.index, view: s.view ?? null, status: s.status,
      assetId: s.assetId ?? null, mediaUrl: s.mediaUrl ?? null, error: s.error ?? null,
    })),
  };
}

async function ownedCharacter(tenantId: string, characterId: string, ex: Tx | typeof db = db) {
  const [character] = await ex.select().from(charactersTable)
    .where(and(eq(charactersTable.id, characterId), eq(charactersTable.tenantId, tenantId)));
  if (!character) throw new CharacterLookError("Character not found", 404);
  return character;
}

function validateModel(modelId: string, operation: "generate" | "edit", cloudConfirmed: boolean | undefined) {
  const model = getImageModel(modelId);
  if (!model) throw new CharacterLookError("Choose a supported image model.", 400);
  if (!model.operations.includes(operation) || (operation === "edit" && model.maxReferences < 1)) {
    throw new CharacterLookError(operation === "edit"
      ? `${model.name} cannot create a reference sheet from an image.`
      : `${model.name} does not support text-to-image.`, 400);
  }
  if (model.provider === "CLOUD" && cloudConfirmed !== true) {
    throw new CharacterLookError(`Confirm this paid batch before submitting. It creates four images (${model.priceNote}).`, 402);
  }
  return model;
}

function newSlots(kind: "PORTRAITS" | "SHEET"): CharacterLookSlot[] {
  return [0, 1, 2, 3].map((index) => ({
    index, requestKey: randomUUID(), status: "PENDING" as const,
    ...(kind === "SHEET" ? { view: SHEET_VIEWS[index]!.view } : {}),
  }));
}

export async function getCharacterLooks(tenantId: string, characterId: string) {
  await ownedCharacter(tenantId, characterId);
  const latest = async (kind: "PORTRAITS" | "SHEET") => (await db.select().from(characterLookBatchesTable)
    .where(and(eq(characterLookBatchesTable.tenantId, tenantId), eq(characterLookBatchesTable.characterId, characterId), eq(characterLookBatchesTable.kind, kind)))
    .orderBy(desc(characterLookBatchesTable.createdAt)).limit(1))[0];
  return { portraits: present(await latest("PORTRAITS")), sheet: present(await latest("SHEET")) };
}

async function byRequestKey(tenantId: string, requestKey: string, ex: Tx) {
  const [existing] = await ex.select().from(characterLookBatchesTable)
    .where(and(eq(characterLookBatchesTable.tenantId, tenantId), eq(characterLookBatchesTable.requestKey, requestKey)));
  return existing;
}

async function activeBatch(characterId: string, kind: "PORTRAITS" | "SHEET", ex: Tx) {
  const [active] = await ex.select({ id: characterLookBatchesTable.id }).from(characterLookBatchesTable)
    .where(and(eq(characterLookBatchesTable.characterId, characterId), eq(characterLookBatchesTable.kind, kind), eq(characterLookBatchesTable.status, "ACTIVE")))
    .limit(1);
  return active;
}

export async function startPortraitBatch(input: {
  tenantId: string; userId: string; characterId: string; prompt: string;
  modelId: string; cloudConfirmed?: boolean; requestKey: string;
}) {
  await ownedCharacter(input.tenantId, input.characterId);
  await db.transaction(async (tx) => {
    await lockCharacter(tx, input.characterId);
    const character = await ownedCharacter(input.tenantId, input.characterId, tx);
    const existing = await byRequestKey(input.tenantId, input.requestKey, tx);
    if (existing) {
      if (existing.characterId !== character.id) throw new CharacterLookError("Request key already used", 409);
      return;
    }
    const prompt = input.prompt.trim();
    if (!prompt) throw new CharacterLookError("Describe the character first.", 400);
    validateModel(input.modelId, "generate", input.cloudConfirmed);
    if (await activeBatch(character.id, "PORTRAITS", tx)) throw new CharacterLookError("Four looks are already generating for this character.", 409);
    await tx.insert(characterLookBatchesTable).values({
      tenantId: input.tenantId, characterId: character.id, createdByUserId: input.userId, kind: "PORTRAITS",
      requestKey: input.requestKey, modelId: input.modelId, cloudConfirmed: input.cloudConfirmed === true,
      prompt, seed: Math.floor(Math.random() * 2_000_000_000), slots: newSlots("PORTRAITS"),
    });
    if (!character.promptDescription) {
      await tx.update(charactersTable).set({ promptDescription: prompt, updatedAt: new Date() }).where(eq(charactersTable.id, character.id));
    }
  });
  return getCharacterLooks(input.tenantId, input.characterId);
}

/** Make the chosen portrait the character's primary headshot, then start its four-view reference sheet. */
export async function keepCharacterLook(input: {
  tenantId: string; userId: string; characterId: string; batchId: string; assetId: string;
  modelId: string; cloudConfirmed?: boolean; requestKey: string;
}, deps: LookJobDeps = defaultLookDeps) {
  await ownedCharacter(input.tenantId, input.characterId);
  let copied: string | null = null;
  try {
    await db.transaction(async (tx) => {
      // The idempotency check, validation, byte copy and inserts all run under the per-character lock,
      // so a racing repeat can neither copy a second primary nor move the selection.
      await lockCharacter(tx, input.characterId);
      const character = await ownedCharacter(input.tenantId, input.characterId, tx);
      const existing = await byRequestKey(input.tenantId, input.requestKey, tx);
      if (existing) {
        if (existing.characterId !== character.id) throw new CharacterLookError("Request key already used", 409);
        return;
      }
      const [batch] = await tx.select().from(characterLookBatchesTable).where(and(
        eq(characterLookBatchesTable.id, input.batchId), eq(characterLookBatchesTable.tenantId, input.tenantId),
        eq(characterLookBatchesTable.characterId, character.id), eq(characterLookBatchesTable.kind, "PORTRAITS")));
      if (!batch) throw new CharacterLookError("Portrait batch not found", 404);
      const slot = batch.slots.find((s) => s.status === "READY" && s.assetId === input.assetId);
      if (!slot) throw new CharacterLookError("Choose one of the finished portraits.", 400);
      validateModel(input.modelId, "edit", input.cloudConfirmed);
      if (await activeBatch(character.id, "SHEET", tx)) throw new CharacterLookError("A reference sheet is still generating for this character.", 409);
      const [image] = await tx.select().from(imageStudioAssetsTable)
        .where(and(eq(imageStudioAssetsTable.id, input.assetId), eq(imageStudioAssetsTable.tenantId, input.tenantId)));
      if (!image) throw new CharacterLookError("The selected portrait is no longer available.", 404);
      // Copy into character storage so deleting a gallery image never breaks the character.
      const storageKey = await deps.storeCharacterImage(`${character.name}-look.png`, image.mimeType, await deps.readBytes(image.storageKey), input.tenantId);
      copied = storageKey;
      await tx.update(characterAssetsTable).set({ isPrimary: false }).where(eq(characterAssetsTable.characterId, character.id));
      await tx.insert(characterAssetsTable).values({
        characterId: character.id, storageKey, originalName: `${character.name}-look.png`.slice(0, 255),
        mimeType: image.mimeType, label: "headshot", angle: "headshot", isPrimary: true, description: "Kept look",
      });
      await tx.update(charactersTable).set({ thumbnail: `/api/media/${storageKey}`, updatedAt: new Date() }).where(eq(charactersTable.id, character.id));
      await invalidateCharacterDossier(input.tenantId, character.id, tx);
      await tx.update(characterLookBatchesTable).set({ selectedAssetId: input.assetId, updatedAt: new Date() }).where(eq(characterLookBatchesTable.id, batch.id));
      await tx.insert(characterLookBatchesTable).values({
        tenantId: input.tenantId, characterId: character.id, createdByUserId: input.userId, kind: "SHEET",
        requestKey: input.requestKey, modelId: input.modelId, cloudConfirmed: input.cloudConfirmed === true,
        prompt: batch.prompt, seed: batch.seed + slot.index, sourceBatchId: batch.id, sourceAssetId: input.assetId,
        slots: newSlots("SHEET"),
      });
    });
  } catch (error) {
    if (copied) await mediaStorage.deleteOutput(copied).catch(() => undefined);
    throw error;
  }
  return getCharacterLooks(input.tenantId, input.characterId);
}

/** Resubmit only failed slots, with fresh keys. Finished or running work is never resubmitted. */
export async function retryCharacterLookBatch(input: { tenantId: string; characterId: string; batchId: string; cloudConfirmed?: boolean }) {
  await ownedCharacter(input.tenantId, input.characterId);
  await db.transaction(async (tx) => {
    await lockCharacter(tx, input.characterId);
    const [batch] = await tx.select().from(characterLookBatchesTable).where(and(
      eq(characterLookBatchesTable.id, input.batchId), eq(characterLookBatchesTable.tenantId, input.tenantId),
      eq(characterLookBatchesTable.characterId, input.characterId))).for("update");
    if (!batch) throw new CharacterLookError("Batch not found", 404);
    if (!batch.slots.some((s) => s.status === "FAILED")) throw new CharacterLookError("Nothing failed in this batch.", 409);
    validateModel(batch.modelId, batch.kind === "SHEET" ? "edit" : "generate", input.cloudConfirmed);
    const slots = batch.slots.map((s) => s.status === "FAILED"
      ? { index: s.index, ...(s.view ? { view: s.view } : {}), requestKey: randomUUID(), status: "PENDING" as const }
      : s);
    await tx.update(characterLookBatchesTable).set({ slots, status: "ACTIVE", cloudConfirmed: input.cloudConfirmed === true, updatedAt: new Date() })
      .where(eq(characterLookBatchesTable.id, batch.id));
  });
  return getCharacterLooks(input.tenantId, input.characterId);
}

function slotPrompt(batch: CharacterLookBatch, slot: CharacterLookSlot) {
  return batch.kind === "SHEET"
    ? `Preserve the exact identity, facial structure and appearance of the reference. Create a ${slot.view} character reference view. ${batch.prompt}`
    : `Character portrait, one subject, clear face, no text. ${batch.prompt}`;
}

/** Advance one batch: submit pending slots, collect finished jobs, attach sheet views. Idempotent and restart-safe. */
export async function advanceCharacterLookBatch(batchId: string, deps: LookJobDeps = defaultLookDeps, clock: () => number = Date.now): Promise<void> {
  await db.transaction(async (tx) => {
    const [batch] = await tx.select().from(characterLookBatchesTable)
      .where(and(eq(characterLookBatchesTable.id, batchId), eq(characterLookBatchesTable.status, "ACTIVE")))
      .for("update", { skipLocked: true });
    if (!batch) return;
    const model = getImageModel(batch.modelId);
    const now = clock();
    const slots = batch.slots.map((s) => ({ ...s }));
    const added: string[] = [];
    for (const slot of slots) {
      if (slot.status === "PENDING" || (slot.status === "RUNNING" && !slot.jobId)) {
        if (slot.nextAttemptAt && Date.parse(slot.nextAttemptAt) > now) continue;
        try {
          // The durable per-slot key makes this call idempotent after a crash or partial submission.
          const job = await deps.createJob({
            tenantId: batch.tenantId, userId: batch.createdByUserId,
            request: {
              modelId: batch.modelId, cloudConfirmed: batch.cloudConfirmed,
              operation: batch.kind === "SHEET" ? "edit" : "generate",
              prompt: slotPrompt(batch, slot), width: WIDTH, height: HEIGHT, count: 1,
              ...(model?.supportsSeed ? { seed: batch.kind === "SHEET" ? batch.seed : batch.seed + slot.index } : {}),
              referenceAssetIds: batch.sourceAssetId ? [batch.sourceAssetId] : [],
              requestKey: slot.requestKey,
            },
          });
          slot.jobId = job.id; slot.status = "RUNNING"; slot.error = undefined; slot.attempts = undefined; slot.nextAttemptAt = undefined;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Image submission failed";
          if (isDeterministicRejection(error)) {
            slot.status = "FAILED"; slot.error = message;
          } else {
            // Outcome unknown or worker busy: keep the SAME request key so the next attempt reconciles
            // with any job the provider already accepted. Never fail it, never mint a new key.
            const waiting = error instanceof ImageStudioRequestError && error.status === 409;
            slot.attempts = (slot.attempts ?? 0) + 1;
            slot.nextAttemptAt = new Date(now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(slot.attempts - 1, 10))).toISOString();
            slot.error = waiting ? "Waiting for an available image worker." : "Confirming submission with the image provider.";
          }
        }
        continue;
      }
      if (slot.status !== "RUNNING" || !slot.jobId) continue;
      const job = await deps.getJob(batch.tenantId, slot.jobId);
      if (!job) { slot.status = "FAILED"; slot.error = "The image job could not be found."; continue; }
      if (job.status === "FAILED" || job.status === "CANCELLED") { slot.status = "FAILED"; slot.error = job.errorMessage || `Image ${job.status.toLowerCase()}.`; continue; }
      if (job.status !== "COMPLETED") continue;
      const asset = job.assets[0];
      if (!asset) { slot.status = "FAILED"; slot.error = "The image job completed without an image."; continue; }
      if (batch.kind === "SHEET" && !slot.characterAssetId) {
        const label = SHEET_VIEWS[slot.index]?.label ?? "other";
        const storageKey = await deps.storeCharacterImage(`reference-${slot.view}.png`, asset.mimeType, await deps.readBytes(asset.storageKey), batch.tenantId);
        added.push(storageKey);
        const [created] = await tx.insert(characterAssetsTable).values({
          characterId: batch.characterId, storageKey, originalName: `reference-${slot.view}.png`, mimeType: asset.mimeType,
          label, angle: slot.view ?? label, description: `Reference sheet: ${slot.view}`, sortOrder: 10 + slot.index,
        }).returning();
        slot.characterAssetId = created!.id;
      }
      slot.assetId = asset.id; slot.mediaUrl = asset.url; slot.status = "READY"; slot.error = undefined;
    }
    const done = slots.every((s) => s.status === "READY" || s.status === "FAILED");
    const status = !done ? "ACTIVE" : slots.some((s) => s.status === "READY") ? "COMPLETED" : "FAILED";
    try {
      await tx.update(characterLookBatchesTable).set({ slots, status, updatedAt: new Date() }).where(eq(characterLookBatchesTable.id, batch.id));
      if (added.length) await invalidateCharacterDossier(batch.tenantId, batch.characterId, tx);
    } catch (error) {
      await Promise.all(added.map((k) => mediaStorage.deleteOutput(k).catch(() => undefined)));
      throw error;
    }
  });
}

let ticking = false;
export async function tickCharacterLooks(deps: LookJobDeps = defaultLookDeps) {
  if (ticking) return;
  ticking = true;
  try {
    const active = await db.select({ id: characterLookBatchesTable.id }).from(characterLookBatchesTable)
      .where(eq(characterLookBatchesTable.status, "ACTIVE")).orderBy(asc(characterLookBatchesTable.createdAt));
    for (const { id } of active) {
      try { await advanceCharacterLookBatch(id, deps); }
      catch (error) { logger.warn({ batchId: id, errorType: error instanceof Error ? error.name : "unknown" }, "Character look batch tick failed"); }
    }
  } finally { ticking = false; }
}

export function startCharacterLookRuntime() {
  const timer = setInterval(() => { void tickCharacterLooks().catch(() => undefined); }, 2500);
  timer.unref();
}

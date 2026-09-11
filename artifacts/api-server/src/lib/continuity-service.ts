import { and, asc, eq, inArray } from "drizzle-orm";
import {
  charactersTable,
  db,
  imageStudioAssetsTable,
  longFormProjectsTable,
  longFormShotsTable,
  pool,
  type LongFormContinuitySettings,
  type LongFormShot,
  type LongFormShotContinuity,
} from "@workspace/db";
import { ResourceNotFoundError } from "./resource-errors";
import { mediaStorage } from "./storage-service";

export const defaultContinuity = (): LongFormContinuitySettings => ({
  enabled: false,
  characters: [],
  scenes: [],
});

export const defaultShotContinuity = (): LongFormShotContinuity => ({
  voiceCloningEnabled: false,
});

export function missingApprovedContinuityShot<T extends {
  stillStatus: string;
  stillStorageKey: string | null;
}>(enabled: boolean, shots: T[]): T | undefined {
  return enabled ? shots.find((shot) => shot.stillStatus !== "APPROVED" || !shot.stillStorageKey) : undefined;
}

export function invalidatedStillValues(stillStorageKey: string | null, stillRevision: number) {
  return {
    stillStatus: stillStorageKey ? "PENDING" : "NONE",
    stillRevision: stillRevision + 1,
    stillApprovedAt: null,
    stillReviewNote: stillStorageKey ? "Still approval must be renewed after continuity changes." : null,
  } as const;
}

type ContinuityInput = LongFormContinuitySettings;
type ShotContinuityInput = LongFormShotContinuity;

async function withContinuityProjectLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [`long-form-project:${projectId}`],
    );
    if (!result.rows[0]?.locked) throw new Error("Project is currently being updated; try again.");
    try {
      return await work();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`long-form-project:${projectId}`]);
    }
  } finally {
    client.release();
  }
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

async function assertTenantCharacters(tenantId: string, ids: string[]): Promise<void> {
  if (!unique(ids)) throw new Error("Character selections must not contain duplicates");
  if (!ids.length) return;
  const characters = await db.select({ id: charactersTable.id }).from(charactersTable)
    .where(and(eq(charactersTable.tenantId, tenantId), inArray(charactersTable.id, ids)));
  if (characters.length !== ids.length) {
    throw new ResourceNotFoundError("One or more continuity characters were not found in this workspace");
  }
}

export async function validateContinuitySettings(
  tenantId: string,
  input: ContinuityInput,
  projectCharacterIds: string[],
): Promise<LongFormContinuitySettings> {
  const settings = {
    enabled: Boolean(input.enabled),
    characters: input.characters ?? [],
    scenes: input.scenes ?? [],
  };
  const characterIds = settings.characters.map((character) => character.characterId);
  if (!unique(settings.scenes.map((scene) => String(scene.sceneNumber)))) {
    throw new Error("Continuity scene numbers must be unique");
  }
  await assertTenantCharacters(tenantId, characterIds);
  if (characterIds.some((id) => !projectCharacterIds.includes(id))) {
    throw new Error("Continuity locks may only reference characters selected for this project");
  }
  const wardrobeKeys = new Set<string>();
  const referenceAssetIds: string[] = [];
  for (const character of settings.characters) {
    if (!unique(character.wardrobes.map((wardrobe) => wardrobe.id))) {
      throw new Error("Wardrobe IDs must be unique for each character");
    }
    for (const wardrobe of character.wardrobes) {
      if (wardrobe.referenceAssetId) referenceAssetIds.push(wardrobe.referenceAssetId);
      wardrobeKeys.add(`${character.characterId}:${wardrobe.id}`);
    }
  }
  if (referenceAssetIds.length) {
    const assets = await db.select({ id: imageStudioAssetsTable.id }).from(imageStudioAssetsTable)
      .where(and(
        eq(imageStudioAssetsTable.tenantId, tenantId),
        inArray(imageStudioAssetsTable.id, referenceAssetIds),
      ));
    if (assets.length !== new Set(referenceAssetIds).size) {
      throw new ResourceNotFoundError("A wardrobe reference asset was not found in this workspace");
    }
  }
  for (const scene of settings.scenes) {
    if (!Number.isInteger(scene.sceneNumber) || scene.sceneNumber < 1) {
      throw new Error("Continuity scenes need a positive whole scene number");
    }
    for (const assignment of scene.wardrobeAssignments) {
      if (!wardrobeKeys.has(`${assignment.characterId}:${assignment.wardrobeId}`)) {
        throw new Error("A scene wardrobe assignment does not match a character wardrobe lock");
      }
    }
  }
  return settings;
}

export async function validateShotContinuity(
  tenantId: string,
  projectCharacterIds: string[],
  input: ShotContinuityInput,
): Promise<LongFormShotContinuity> {
  const characterIds = input.characterIds?.length ? input.characterIds : undefined;
  if (characterIds) {
    await assertTenantCharacters(tenantId, characterIds);
    if (characterIds.some((id) => !projectCharacterIds.includes(id))) {
      throw new Error("Shot cast may only use characters selected for this project");
    }
  }
  const cast = characterIds ?? projectCharacterIds;
  if (input.speakerCharacterId && !cast.includes(input.speakerCharacterId)) {
    throw new Error("The shot speaker must be included in its cast");
  }
  if (input.voiceCloningEnabled === true) {
    if (!input.speakerCharacterId) {
      throw new Error("Voice cloning requires an explicitly selected shot speaker");
    }
    const [speaker] = await db.select({
      voiceStorageKey: charactersTable.voiceStorageKey,
      voiceConsentAt: charactersTable.voiceConsentAt,
    }).from(charactersTable).where(and(
      eq(charactersTable.id, input.speakerCharacterId),
      eq(charactersTable.tenantId, tenantId),
    ));
    if (!speaker?.voiceStorageKey || !speaker.voiceConsentAt) {
      throw new Error("Voice cloning requires the selected speaker to have a consented voice sample");
    }
  }
  return {
    ...(characterIds ? { characterIds } : {}),
    ...(input.speakerCharacterId ? { speakerCharacterId: input.speakerCharacterId } : {}),
    voiceCloningEnabled: input.voiceCloningEnabled === true,
    ...(input.emotionNotes?.trim() ? { emotionNotes: input.emotionNotes.trim() } : {}),
    ...(input.performanceNotes?.trim() ? { performanceNotes: input.performanceNotes.trim() } : {}),
  };
}

export function stillForShot(shot: LongFormShot) {
  return {
    status: shot.stillStatus as "NONE" | "PENDING" | "APPROVED" | "REJECTED",
    assetUrl: shot.stillStorageKey ? `/api/media/${shot.stillStorageKey}` : null,
    revision: shot.stillRevision,
    approvedAt: shot.stillApprovedAt?.toISOString() ?? null,
    reviewNote: shot.stillReviewNote,
  };
}

export async function assertEditableShot(projectId: string, shotId: string): Promise<LongFormShot> {
  const [project] = await db.select({ status: longFormProjectsTable.status }).from(longFormProjectsTable)
    .where(eq(longFormProjectsTable.id, projectId));
  if (!project) throw new ResourceNotFoundError("Long-form project not found");
  if (["RUNNING", "ASSEMBLING", "COMPLETED"].includes(project.status)) {
    throw new Error("Pause production before changing continuity or stills; completed projects must retry a shot first.");
  }
  const [shot] = await db.select().from(longFormShotsTable).where(and(
    eq(longFormShotsTable.id, shotId),
    eq(longFormShotsTable.projectId, projectId),
  ));
  if (!shot) throw new ResourceNotFoundError("Long-form shot not found");
  if (["QUEUED", "RENDERING", "COMPLETED"].includes(shot.status)) {
    throw new Error("This shot cannot be changed while rendering or after completion; retry it first.");
  }
  return shot;
}

export async function invalidateShotStill(shotId: string): Promise<void> {
  const [shot] = await db.select({
    stillRevision: longFormShotsTable.stillRevision,
    stillStorageKey: longFormShotsTable.stillStorageKey,
  }).from(longFormShotsTable).where(eq(longFormShotsTable.id, shotId));
  if (!shot) return;
  await db.update(longFormShotsTable).set(invalidatedStillValues(shot.stillStorageKey, shot.stillRevision))
    .where(and(eq(longFormShotsTable.id, shotId), eq(longFormShotsTable.stillRevision, shot.stillRevision)));
}

async function setShotStillFromAssetUnlocked(input: {
  projectId: string;
  shotId: string;
  tenantId: string;
  assetId: string;
}) {
  await assertEditableShot(input.projectId, input.shotId);
  const [asset] = await db.select().from(imageStudioAssetsTable).where(and(
    eq(imageStudioAssetsTable.id, input.assetId),
    eq(imageStudioAssetsTable.tenantId, input.tenantId),
  ));
  if (!asset) throw new ResourceNotFoundError("Image Studio asset not found");
  const storageKey = await mediaStorage.storeContinuityStill(
    asset.name,
    asset.mimeType,
    await mediaStorage.readBuffer(asset.storageKey),
    input.tenantId,
  );
  const [shot] = await db.update(longFormShotsTable).set({
    stillAssetId: null,
    stillStorageKey: storageKey,
    stillMimeType: asset.mimeType,
    stillStatus: "PENDING",
    stillRevision: (await db.select({ stillRevision: longFormShotsTable.stillRevision })
      .from(longFormShotsTable).where(eq(longFormShotsTable.id, input.shotId)))[0]!.stillRevision + 1,
    stillApprovedAt: null,
    stillReviewNote: null,
  }).where(and(eq(longFormShotsTable.id, input.shotId), eq(longFormShotsTable.projectId, input.projectId))).returning();
  return shot!;
}

export async function setShotStillFromAsset(input: {
  projectId: string;
  shotId: string;
  tenantId: string;
  assetId: string;
}) {
  return withContinuityProjectLock(input.projectId, () => setShotStillFromAssetUnlocked(input));
}

async function reviewShotStillUnlocked(input: {
  projectId: string;
  shotId: string;
  revision: number;
  action: "approve" | "reject";
  note?: string;
}) {
  await assertEditableShot(input.projectId, input.shotId);
  const [shot] = await db.update(longFormShotsTable).set({
    stillStatus: input.action === "approve" ? "APPROVED" : "REJECTED",
    stillApprovedAt: input.action === "approve" ? new Date() : null,
    stillReviewNote: input.note?.trim() || null,
  }).where(and(
    eq(longFormShotsTable.id, input.shotId),
    eq(longFormShotsTable.projectId, input.projectId),
    eq(longFormShotsTable.stillRevision, input.revision),
    inArray(longFormShotsTable.stillStatus, input.action === "reject" ? ["PENDING", "APPROVED"] : ["PENDING"]),
  )).returning();
  if (!shot) throw new Error("The still changed or is not awaiting review; refresh before reviewing it");
  return shot;
}

export async function reviewShotStill(input: {
  projectId: string;
  shotId: string;
  revision: number;
  action: "approve" | "reject";
  note?: string;
}) {
  return withContinuityProjectLock(input.projectId, () => reviewShotStillUnlocked(input));
}

async function clearShotStillUnlocked(projectId: string, shotId: string) {
  await assertEditableShot(projectId, shotId);
  const [shot] = await db.update(longFormShotsTable).set({
    stillAssetId: null,
    stillStorageKey: null,
    stillMimeType: null,
    stillStatus: "NONE",
    stillRevision: (await db.select({ stillRevision: longFormShotsTable.stillRevision })
      .from(longFormShotsTable).where(eq(longFormShotsTable.id, shotId)))[0]!.stillRevision + 1,
    stillApprovedAt: null,
    stillReviewNote: null,
  }).where(and(eq(longFormShotsTable.id, shotId), eq(longFormShotsTable.projectId, projectId))).returning();
  return shot!;
}

export async function clearShotStill(projectId: string, shotId: string) {
  return withContinuityProjectLock(projectId, () => clearShotStillUnlocked(projectId, shotId));
}

export async function activeShotsForProject(projectId: string) {
  return db.select({ id: longFormShotsTable.id }).from(longFormShotsTable).where(and(
    eq(longFormShotsTable.projectId, projectId),
    inArray(longFormShotsTable.status, ["QUEUED", "RENDERING"]),
  )).orderBy(asc(longFormShotsTable.sceneNumber));
}
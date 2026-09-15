import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  characterAssetsTable,
  charactersTable,
  db,
  comfyServersTable,
  imageStudioAssetsTable,
  imageStudioJobsTable,
  type CharacterDossier,
  type ImageStudioJob,
  type CharacterWardrobe,
} from "@workspace/db";

export const CHARACTER_ASSET_LABELS = [
  "headshot",
  "profile",
  "three-quarter",
  "full-body",
  "expression",
  "wardrobe",
  "other",
] as const;
const LEGACY_CHARACTER_SUBMISSION_UNCERTAIN_MESSAGE =
  "The image worker submission is still being reconciled. No duplicate render will be submitted.";
const CHARACTER_CLOUD_SUBMISSION_UNCERTAIN_MESSAGE =
  "Cloud image submission status could not be confirmed. No duplicate render was submitted.";

export type CharacterAssetLabel = (typeof CHARACTER_ASSET_LABELS)[number];
export const APPEARANCE_LABELS = ["profile", "three-quarter", "full-body"] as const;
type CharacterDbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CharacterDbExecutor = typeof db | CharacterDbTransaction;

const emptyDossier: CharacterDossier = {
  role: "",
  performanceNotes: "",
  wardrobes: [],
};

export function isCharacterAssetLabel(value: unknown): value is CharacterAssetLabel {
  return typeof value === "string"
    && (CHARACTER_ASSET_LABELS as readonly string[]).includes(value);
}

export function hasApprovalReferences(labels: readonly CharacterAssetLabel[]): boolean {
  return labels.includes("headshot") && APPEARANCE_LABELS.some((label) => labels.includes(label));
}

export function missingWardrobeReferences(referenceIds: readonly string[], ownedIds: readonly string[]): string[] {
  const owned = new Set(ownedIds);
  return [...new Set(referenceIds)].filter((id) => !owned.has(id));
}

export function characterAssetJobReferences(
  job: {
    status: string;
    referenceAssetIds: string[];
    outputStorageKey: string | null;
    providerTaskMetadata: Record<string, unknown>;
  },
  asset: { id: string; storageKey: string },
): boolean {
  if (job.status !== "QUEUED" && job.status !== "RUNNING") return false;
  if (job.referenceAssetIds.includes(asset.id) || job.outputStorageKey === asset.storageKey) return true;
  const source = job.providerTaskMetadata.sourceReference;
  return Boolean(
    source
    && typeof source === "object"
    && !Array.isArray(source)
    && (source as Record<string, unknown>).assetId === asset.id,
  );
}

export function revisionMatches(currentRevision: number, expectedRevision: number): boolean {
  return currentRevision === expectedRevision;
}

function normalizeWardrobe(wardrobe: CharacterWardrobe): CharacterWardrobe {
  return {
    id: wardrobe.id,
    name: wardrobe.name,
    description: wardrobe.description,
    referenceAssetId: wardrobe.referenceAssetId ?? null,
  };
}

export function normalizeDossier(value: unknown): CharacterDossier {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyDossier;
  const source = value as Partial<CharacterDossier>;
  return {
    role: typeof source.role === "string" ? source.role : "",
    performanceNotes: typeof source.performanceNotes === "string" ? source.performanceNotes : "",
    wardrobes: Array.isArray(source.wardrobes)
      ? source.wardrobes
        .filter((wardrobe): wardrobe is CharacterWardrobe => (
          Boolean(wardrobe)
          && typeof wardrobe === "object"
          && typeof wardrobe.id === "string"
          && typeof wardrobe.name === "string"
          && typeof wardrobe.description === "string"
        ))
        .map(normalizeWardrobe)
      : [],
  };
}

export function mergeDossierValues(
  latest: CharacterDossier,
  update: Partial<CharacterDossier>,
): CharacterDossier {
  return {
    role: update.role ?? latest.role,
    performanceNotes: update.performanceNotes ?? latest.performanceNotes,
    wardrobes: (update.wardrobes ?? latest.wardrobes).map(normalizeWardrobe),
  };
}

function assetLabel(asset: { label: string; angle: string | null }): CharacterAssetLabel {
  if (isCharacterAssetLabel(asset.label)) return asset.label;
  return "other";
}

function mediaUrl(storageKey: string): string {
  return `/api/media/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
}

function sourceReferenceFromJobMetadata(metadata: Record<string, unknown>): {
  assetId: string;
  mediaUrl: string;
  label: CharacterAssetLabel;
} | null {
  const source = metadata.sourceReference;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const reference = source as Record<string, unknown>;
  if (
    typeof reference.assetId !== "string"
    || typeof reference.storageKey !== "string"
    || !isCharacterAssetLabel(reference.label)
  ) {
    return null;
  }
  return {
    assetId: reference.assetId,
    mediaUrl: mediaUrl(reference.storageKey),
    label: reference.label,
  };
}

export function presentCharacterAsset(asset: {
  id: string;
  storageKey: string;
  label: string;
  angle: string | null;
  description: string;
  isPrimary?: boolean;
}) {
  return {
    id: asset.id,
    mediaUrl: mediaUrl(asset.storageKey),
    label: assetLabel(asset),
    description: asset.description,
    ...(asset.isPrimary === undefined ? {} : { isPrimary: asset.isPrimary }),
  };
}

async function dossierCharacter(tenantId: string, characterId: string) {
  const [character] = await db.select().from(charactersTable).where(and(
    eq(charactersTable.id, characterId),
    eq(charactersTable.tenantId, tenantId),
  ));
  return character;
}

async function dossierAssets(characterId: string, executor: CharacterDbExecutor = db) {
  return executor.select({
    id: characterAssetsTable.id,
    storageKey: characterAssetsTable.storageKey,
    label: characterAssetsTable.label,
    angle: characterAssetsTable.angle,
    description: characterAssetsTable.description,
    isPrimary: characterAssetsTable.isPrimary,
  }).from(characterAssetsTable)
    .where(eq(characterAssetsTable.characterId, characterId))
    .orderBy(asc(characterAssetsTable.createdAt), asc(characterAssetsTable.id));
}

export function presentCharacterImageGeneration(
  job: ImageStudioJob,
  serverName: string | null,
) {
  const validLabel = isCharacterAssetLabel(job.referenceLabel)
    ? job.referenceLabel
    : null;
  const sourceReference = sourceReferenceFromJobMetadata(job.providerTaskMetadata);
  const progress = typeof job.providerTaskMetadata.progress === "number"
    && Number.isFinite(job.providerTaskMetadata.progress)
    && job.providerTaskMetadata.progress >= 0
    && job.providerTaskMetadata.progress <= 1
    ? job.providerTaskMetadata.progress
    : null;
  const progressStage = job.providerTaskMetadata.progressStage === "rendering"
    || job.providerTaskMetadata.progressStage === "saving"
    ? job.providerTaskMetadata.progressStage
    : "preparing";
  const progressStep = typeof job.providerTaskMetadata.progressStep === "number"
    && Number.isFinite(job.providerTaskMetadata.progressStep)
    && job.providerTaskMetadata.progressStep >= 0
    ? job.providerTaskMetadata.progressStep
    : null;
  const progressTotalSteps = typeof job.providerTaskMetadata.progressTotalSteps === "number"
    && Number.isFinite(job.providerTaskMetadata.progressTotalSteps)
    && job.providerTaskMetadata.progressTotalSteps >= 0
    ? job.providerTaskMetadata.progressTotalSteps
    : null;
  const progressUpdatedAt = typeof job.providerTaskMetadata.progressUpdatedAt === "string"
    && Number.isFinite(Date.parse(job.providerTaskMetadata.progressUpdatedAt))
    ? new Date(job.providerTaskMetadata.progressUpdatedAt).toISOString()
    : null;
  const errorMessage = job.provider === "CLOUD"
    && job.status === "FAILED"
    && job.errorMessage === LEGACY_CHARACTER_SUBMISSION_UNCERTAIN_MESSAGE
    ? CHARACTER_CLOUD_SUBMISSION_UNCERTAIN_MESSAGE
    : job.errorMessage;
  return {
    id: job.id,
    modelId: job.modelId,
    modelName: job.modelName,
    provider: job.provider,
    status: job.status,
    prompt: job.prompt,
    referenceLabel: validLabel,
    referenceAssetId: sourceReference?.assetId ?? null,
    referenceUsed: job.providerTaskMetadata.referenceUsed === true || Boolean(sourceReference),
    sourceReference,
    seed: job.seed,
    serverName,
    mediaUrl: job.outputStorageKey ? `/api/media/${job.outputStorageKey}` : null,
    assetId: typeof job.providerTaskMetadata.characterAssetId === "string"
      ? job.providerTaskMetadata.characterAssetId
      : null,
    errorMessage,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    progress: job.status === "COMPLETED" ? 1 : progress,
    progressStage: job.status === "COMPLETED" ? "saving" : progressStage,
    progressStep,
    progressTotalSteps,
    progressUpdatedAt,
    startedAt: job.startedAt?.toISOString() ?? null,
  };
}

async function dossierImageGeneration(tenantId: string, characterId: string) {
  const [result] = await db
    .select({
      job: imageStudioJobsTable,
      serverName: comfyServersTable.displayName,
    })
    .from(imageStudioJobsTable)
    .leftJoin(comfyServersTable, eq(comfyServersTable.id, imageStudioJobsTable.comfyServerId))
    .where(and(
      eq(imageStudioJobsTable.tenantId, tenantId),
      eq(imageStudioJobsTable.characterId, characterId),
    ))
    .orderBy(desc(imageStudioJobsTable.createdAt))
    .limit(1);
  if (!result) return null;
  return presentCharacterImageGeneration(result.job, result.serverName);
}

async function validateWardrobeReferences(
  tenantId: string,
  dossier: CharacterDossier,
  executor: CharacterDbExecutor,
): Promise<void> {
  const wardrobeRefs = dossier.wardrobes
    .map((wardrobe) => wardrobe.referenceAssetId)
    .filter((assetId): assetId is string => Boolean(assetId));
  if (wardrobeRefs.length === 0) return;
  const ownedAssets = await executor.select({ id: imageStudioAssetsTable.id })
    .from(imageStudioAssetsTable)
    .where(and(
      eq(imageStudioAssetsTable.tenantId, tenantId),
      inArray(imageStudioAssetsTable.id, wardrobeRefs),
    ));
  if (missingWardrobeReferences(wardrobeRefs, ownedAssets.map((asset) => asset.id)).length > 0) {
    throw new Error("Every wardrobe referenceAssetId must be an Image Studio asset owned by this tenant");
  }
}

export async function getCharacterDossier(tenantId: string, characterId: string) {
  const character = await dossierCharacter(tenantId, characterId);
  if (!character) return null;
  const assets = await dossierAssets(character.id);
  const imageGeneration = await dossierImageGeneration(tenantId, character.id);
  return {
    ...normalizeDossier(character.dossier),
    status: character.dossierStatus,
    revision: character.dossierRevision,
    approvedAt: character.dossierApprovedAt?.toISOString() ?? null,
    assets: assets.map(presentCharacterAsset),
    imageGeneration,
  };
}

export async function replaceCharacterDossier(input: {
  tenantId: string;
  characterId: string;
  revision: number;
  dossier: Partial<CharacterDossier>;
}) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(charactersTable).where(and(
      eq(charactersTable.id, input.characterId),
      eq(charactersTable.tenantId, input.tenantId),
    )).for("update");
    if (!current) return { kind: "missing" as const };
    if (!revisionMatches(current.dossierRevision, input.revision)) {
      return { kind: "stale" as const, currentRevision: current.dossierRevision };
    }
    const latest = normalizeDossier(current.dossier);
    const dossier = mergeDossierValues(latest, input.dossier);
    await validateWardrobeReferences(input.tenantId, dossier, tx);
    const [character] = await tx.update(charactersTable).set({
      dossier,
      dossierStatus: "DRAFT",
      dossierApprovedAt: null,
      dossierRevision: sql`${charactersTable.dossierRevision} + 1`,
    }).where(and(
      eq(charactersTable.id, input.characterId),
      eq(charactersTable.tenantId, input.tenantId),
      eq(charactersTable.dossierRevision, input.revision),
    )).returning();
    if (!character) {
      return { kind: "stale" as const, currentRevision: current.dossierRevision };
    }
    const assets = await dossierAssets(character.id, tx);
    return {
      kind: "ok" as const,
      dossier: {
        ...normalizeDossier(character.dossier),
        status: character.dossierStatus,
        revision: character.dossierRevision,
        approvedAt: null,
        assets: assets.map(presentCharacterAsset),
      },
    };
  });
}

export async function approveCharacterDossier(input: {
  tenantId: string;
  characterId: string;
  revision: number;
}) {
  return db.transaction(async (tx) => {
    const [character] = await tx.select().from(charactersTable).where(and(
      eq(charactersTable.id, input.characterId),
      eq(charactersTable.tenantId, input.tenantId),
    ));
    if (!character) return { kind: "missing" as const };
    if (!revisionMatches(character.dossierRevision, input.revision)) {
      return { kind: "stale" as const, currentRevision: character.dossierRevision };
    }

    const assets = await tx.select({
      label: characterAssetsTable.label,
      angle: characterAssetsTable.angle,
    }).from(characterAssetsTable)
      .where(eq(characterAssetsTable.characterId, character.id));
    const labels = assets.map(assetLabel);
    if (!hasApprovalReferences(labels)) {
      return {
        kind: "invalid" as const,
        message: "Approval requires at least one headshot and one appearance reference (profile, three-quarter, or full-body)",
      };
    }

    const approvedAt = new Date();
    const [updated] = await tx.update(charactersTable).set({
      dossierStatus: "APPROVED",
      dossierApprovedAt: approvedAt,
    }).where(and(
      eq(charactersTable.id, character.id),
      eq(charactersTable.tenantId, input.tenantId),
      eq(charactersTable.dossierRevision, input.revision),
    )).returning();
    if (!updated) return { kind: "stale" as const, currentRevision: input.revision };
    const dossierAssets = await tx.select({
      id: characterAssetsTable.id,
      storageKey: characterAssetsTable.storageKey,
      label: characterAssetsTable.label,
      angle: characterAssetsTable.angle,
      description: characterAssetsTable.description,
      isPrimary: characterAssetsTable.isPrimary,
    }).from(characterAssetsTable)
      .where(eq(characterAssetsTable.characterId, character.id));
    return {
      kind: "ok" as const,
      dossier: {
        ...normalizeDossier(updated.dossier),
        status: updated.dossierStatus,
        revision: updated.dossierRevision,
        approvedAt: approvedAt.toISOString(),
        assets: dossierAssets.map(presentCharacterAsset),
      },
    };
  });
}

export async function invalidateCharacterDossier(
  tenantId: string,
  characterId: string,
  executor: CharacterDbExecutor = db,
): Promise<void> {
  await executor.update(charactersTable).set({
    dossierStatus: "DRAFT",
    dossierApprovedAt: null,
    dossierRevision: sql`${charactersTable.dossierRevision} + 1`,
  }).where(and(
    eq(charactersTable.id, characterId),
    eq(charactersTable.tenantId, tenantId),
  ));
}
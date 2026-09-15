import { and, asc, eq, inArray } from "drizzle-orm";
import express, { Router, type IRouter } from "express";
import {
  ApproveCharacterDossierBody,
  ApproveCharacterDossierResponse,
  ApproveCharacterDossierParams,
  CreateCharacterBody,
  CreateCharacterResponse,
  DeleteCharacterParams,
  GenerateCharacterImageBody,
  GenerateCharacterImageParams,
  GenerateCharacterImageResponse,
  GetCharacterDossierParams,
  GetCharacterDossierResponse,
  ListCharactersResponse,
  UpdateCharacterAssetBody,
  UpdateCharacterAssetParams,
  UpdateCharacterAssetResponse,
  UpdateCharacterDossierBody,
  UpdateCharacterDossierParams,
  UpdateCharacterDossierResponse,
  DeleteCharacterAssetParams,
  UpdateCharacterBody,
  UpdateCharacterParams,
  UpdateCharacterResponse,
} from "@workspace/api-zod";
import {
  characterAssetsTable,
  charactersTable,
  db,
  imageStudioJobsTable,
} from "@workspace/db";
import {
  CHARACTER_ASSET_LABELS,
  approveCharacterDossier,
  characterAssetJobReferences,
  getCharacterDossier,
  invalidateCharacterDossier,
  isCharacterAssetLabel,
  normalizeDossier,
  presentCharacterAsset,
  replaceCharacterDossier,
} from "../lib/character-dossier-service";
import { mediaStorage } from "../lib/storage-service";
import {
  createCharacterImageJob,
  CharacterImageGenerationConflictError,
  StudioImageGenerationUnavailableError,
} from "../lib/studio-image-generation";
import { presentCharacter } from "../lib/studio-presenters";

const router: IRouter = Router();

async function list(tenantId: string) {
  const characters = await db.select().from(charactersTable)
    .where(eq(charactersTable.tenantId, tenantId))
    .orderBy(asc(charactersTable.createdAt), asc(charactersTable.id));
  return Promise.all(characters.map(async (character) => {
    const assets = await db.select({ id: characterAssetsTable.id }).from(characterAssetsTable).where(eq(characterAssetsTable.characterId, character.id));
    return presentCharacter(character, assets.length);
  }));
}

router.get("/characters", async (req, res): Promise<void> => {
  res.json(ListCharactersResponse.parse(await list(req.context!.tenant!.id)));
});

router.post("/characters", async (req, res): Promise<void> => {
  const input = CreateCharacterBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  const [character] = await db.insert(charactersTable).values({
    ...input.data,
    tenantId: req.context!.tenant!.id,
    createdByUserId: req.context!.user.id,
  }).returning();
  res.status(201).json(CreateCharacterResponse.parse(presentCharacter(character, 0)));
});

router.patch("/characters/:id", async (req, res): Promise<void> => {
  const params = UpdateCharacterParams.safeParse(req.params);
  const input = UpdateCharacterBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  const { expectedDossierRevision, ...characterUpdate } = input.data;
  const result = await db.transaction(async (tx) => {
    if (expectedDossierRevision !== undefined) {
      const [current] = await tx.select({
        dossierRevision: charactersTable.dossierRevision,
      }).from(charactersTable).where(and(
        eq(charactersTable.id, params.data.id),
        eq(charactersTable.tenantId, req.context!.tenant!.id),
      )).for("update");
      if (!current) return { kind: "missing" as const };
      if (current.dossierRevision !== expectedDossierRevision) {
        return {
          kind: "stale" as const,
          currentRevision: current.dossierRevision,
        };
      }
    }
    const [character] = await tx.update(charactersTable).set(characterUpdate).where(and(
      eq(charactersTable.id, params.data.id),
      eq(charactersTable.tenantId, req.context!.tenant!.id),
    )).returning();
    if (!character) return { kind: "missing" as const };
    await invalidateCharacterDossier(req.context!.tenant!.id, character.id, tx);
    const assets = await tx.select({ id: characterAssetsTable.id })
      .from(characterAssetsTable)
      .where(eq(characterAssetsTable.characterId, character.id));
    return {
      kind: "ok" as const,
      character: presentCharacter(character, assets.length, character.dossierRevision + 1),
    };
  });
  if (result.kind === "missing") {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (result.kind === "stale") {
    res.status(409).json({
      error: "Character dossier changed; refresh before saving identity fields",
      revision: result.currentRevision,
    });
    return;
  }
  res.json(UpdateCharacterResponse.parse(result.character));
});

router.delete("/characters/:id", async (req, res): Promise<void> => {
  const params = DeleteCharacterParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [character] = await tx
      .select()
      .from(charactersTable)
      .where(and(
        eq(charactersTable.id, params.data.id),
        eq(charactersTable.tenantId, req.context!.tenant!.id),
      ))
      .for("update")
      .limit(1);
    if (!character) return { kind: "missing" as const };
    const [activeJob] = await tx
      .select({ id: imageStudioJobsTable.id })
      .from(imageStudioJobsTable)
      .where(and(
        eq(imageStudioJobsTable.characterId, character.id),
        inArray(imageStudioJobsTable.status, ["QUEUED", "RUNNING"]),
      ))
      .limit(1);
    if (activeJob) return { kind: "active" as const };
    const [deleted] = await tx
      .delete(charactersTable)
      .where(eq(charactersTable.id, character.id))
      .returning();
    return deleted ? { kind: "deleted" as const, character: deleted } : { kind: "missing" as const };
  });
  if (result.kind === "active") {
    res.status(409).json({
      error: "Character cannot be deleted while an image generation is queued or running",
    });
    return;
  }
  const deleted = result.kind === "deleted" ? result.character : undefined;
  if (!deleted) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (deleted.voiceStorageKey) await mediaStorage.deleteVoiceSample(deleted.voiceStorageKey);
  res.sendStatus(204);
});

router.get("/characters/:id/dossier", async (req, res): Promise<void> => {
  const params = GetCharacterDossierParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dossier = await getCharacterDossier(req.context!.tenant!.id, params.data.id);
  if (!dossier) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  res.json(GetCharacterDossierResponse.parse(dossier));
});

router.put("/characters/:id/dossier", async (req, res): Promise<void> => {
  const params = UpdateCharacterDossierParams.safeParse(req.params);
  const input = UpdateCharacterDossierBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  try {
    const result = await replaceCharacterDossier({
      tenantId: req.context!.tenant!.id,
      characterId: params.data.id,
      revision: input.data.revision,
      dossier: input.data,
    });
    if (result.kind === "missing") {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    if (result.kind === "stale") {
      res.status(409).json({
        error: "Character dossier changed; refresh before saving",
        revision: result.currentRevision,
      });
      return;
    }
    res.json(UpdateCharacterDossierResponse.parse(result.dossier));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Character dossier update failed" });
  }
});

router.post("/characters/:id/dossier/approve", async (req, res): Promise<void> => {
  const params = ApproveCharacterDossierParams.safeParse(req.params);
  const input = ApproveCharacterDossierBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  const result = await approveCharacterDossier({
    tenantId: req.context!.tenant!.id,
    characterId: params.data.id,
    revision: input.data.revision,
  });
  if (result.kind === "missing") {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (result.kind === "stale") {
    res.status(409).json({ error: "Character dossier changed; refresh before approving", revision: result.currentRevision });
    return;
  }
  if (result.kind === "invalid") {
    res.status(400).json({ error: result.message });
    return;
  }
  res.json(ApproveCharacterDossierResponse.parse(result.dossier));
});

router.post("/characters/:id/generate-image", async (req, res): Promise<void> => {
  const params = GenerateCharacterImageParams.safeParse(req.params);
  const input = GenerateCharacterImageBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  try {
    const [owned] = await db.select({ id: charactersTable.id }).from(charactersTable).where(and(
      eq(charactersTable.id, params.data.id),
      eq(charactersTable.tenantId, req.context!.tenant!.id),
    ));
    if (!owned) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    const result = await createCharacterImageJob({
      tenantId: req.context!.tenant!.id,
      userId: req.context!.user.id,
      characterId: params.data.id,
       modelId: input.data.modelId,
       cloudConfirmed: input.data.cloudConfirmed,
      prompt: input.data.prompt,
      seed: input.data.seed,
      referenceLabel: input.data.referenceLabel,
      referenceAssetId: input.data.referenceAssetId,
      denoiseStrength: input.data.denoiseStrength,
      allowNewIdentity: input.data.allowNewIdentity,
      requestKey: input.data.requestKey,
    });
    res.status(202).json(GenerateCharacterImageResponse.parse(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Character image generation failed";
    const status = error instanceof StudioImageGenerationUnavailableError
      ? 503
      : error instanceof CharacterImageGenerationConflictError
        ? 409
        : message === "Character not found" || message === "Character reference asset not found"
          ? 404
          : /Confirm this paid Cloud job/i.test(message)
            ? 402
          : /Cloud credentials are not configured|Cloud image spend|pricing unavailable/i.test(message)
            ? 503
            : 400;
    res.status(status).json({ error: message });
  }
});

router.post("/characters/:id/assets", express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "15mb" }), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [character] = await db.select().from(charactersTable).where(and(
    eq(charactersTable.id, id),
    eq(charactersTable.tenantId, req.context!.tenant!.id),
  ));
  if (!character) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  const contentType = req.header("content-type") ?? "";
  const originalName = req.header("x-file-name") ?? "reference-image";
  const label = req.header("x-asset-label") ?? "other";
  if (!isCharacterAssetLabel(label)) {
    res.status(400).json({ error: `Asset label must be one of ${CHARACTER_ASSET_LABELS.join(", ")}` });
    return;
  }
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "Send image bytes directly with an image Content-Type" });
    return;
  }
  try {
    const storageKey = await mediaStorage.storeImage(originalName, contentType, req.body, "characters", req.context!.tenant!.id);
    try {
      const [asset] = await db.transaction(async (tx) => {
        const [created] = await tx.insert(characterAssetsTable).values({
          characterId: character.id,
          storageKey,
          originalName: originalName.slice(0, 255),
          mimeType: contentType,
          angle: req.header("x-asset-label")?.slice(0, 120) ?? null,
          label,
          description: req.header("x-asset-description")?.slice(0, 500) ?? "",
        }).returning();
        await invalidateCharacterDossier(req.context!.tenant!.id, character.id, tx);
        return [created] as const;
      });
      res.status(201).json({ ok: true, assetId: asset.id, mediaUrl: `/api/media/${storageKey}` });
    } catch (error) {
      await mediaStorage.deleteOutput(storageKey).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Asset upload failed" });
  }
});

router.patch("/characters/:id/assets/:assetId", async (req, res): Promise<void> => {
  const params = UpdateCharacterAssetParams.safeParse(req.params);
  const parsedInput = UpdateCharacterAssetBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsedInput.success) {
    res.status(400).json({ error: parsedInput.error.message });
    return;
  }
  const input = parsedInput.data;
  if (input.label === undefined && input.description === undefined && input.makePrimary === undefined) {
    res.status(400).json({ error: "At least one asset field must be provided" });
    return;
  }
  const tenantId = req.context!.tenant!.id;
  try {
    const result = await db.transaction(async (tx) => {
      const [character] = await tx.select().from(charactersTable).where(and(
        eq(charactersTable.id, params.data.id),
        eq(charactersTable.tenantId, tenantId),
      ));
      if (!character) return { kind: "character-missing" as const };
      const [asset] = await tx.select().from(characterAssetsTable).where(and(
        eq(characterAssetsTable.id, params.data.assetId),
        eq(characterAssetsTable.characterId, character.id),
      ));
      if (!asset) return { kind: "asset-missing" as const };
      if (input.makePrimary === true) {
        await tx.update(characterAssetsTable).set({ isPrimary: false }).where(eq(characterAssetsTable.characterId, character.id));
      }
      const [changed] = await tx.update(characterAssetsTable).set({
        ...(input.label === undefined ? {} : { label: input.label, angle: input.label }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.makePrimary === undefined ? {} : { isPrimary: input.makePrimary }),
      }).where(and(
        eq(characterAssetsTable.id, asset.id),
        eq(characterAssetsTable.characterId, character.id),
      )).returning();
      if (!changed) return { kind: "asset-missing" as const };
      if (input.makePrimary !== undefined) {
        const assetMediaUrl = `/api/media/${asset.storageKey}`;
        await tx.update(charactersTable).set({
          thumbnail: input.makePrimary
            ? `/api/media/${changed!.storageKey}`
            : (asset.isPrimary || character.thumbnail === assetMediaUrl ? null : character.thumbnail),
        }).where(eq(charactersTable.id, character.id));
      }
      await invalidateCharacterDossier(tenantId, character.id, tx);
      const assets = await tx.select({
        id: characterAssetsTable.id,
        storageKey: characterAssetsTable.storageKey,
        label: characterAssetsTable.label,
        angle: characterAssetsTable.angle,
        description: characterAssetsTable.description,
        isPrimary: characterAssetsTable.isPrimary,
      }).from(characterAssetsTable)
        .where(eq(characterAssetsTable.characterId, character.id));
      const [updatedCharacter] = await tx.select().from(charactersTable)
        .where(and(
          eq(charactersTable.id, character.id),
          eq(charactersTable.tenantId, tenantId),
        ));
      return {
        kind: "ok" as const,
        changed: changed!,
        assets,
        dossier: {
          ...normalizeDossier(updatedCharacter.dossier),
          status: updatedCharacter.dossierStatus,
          revision: updatedCharacter.dossierRevision,
          approvedAt: updatedCharacter.dossierApprovedAt?.toISOString() ?? null,
          assets: assets.map(presentCharacterAsset),
        },
      };
    });
    if (result.kind === "character-missing") {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    if (result.kind === "asset-missing") {
      res.status(404).json({ error: "Character asset not found" });
      return;
    }
    res.json(UpdateCharacterAssetResponse.parse({
      ...presentCharacterAsset(result.changed),
      ...result.dossier,
    }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Character asset update failed" });
  }
});

router.delete("/characters/:id/assets/:assetId", async (req, res): Promise<void> => {
  const params = DeleteCharacterAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const tenantId = req.context!.tenant!.id;
  const result = await db.transaction(async (tx) => {
    const [character] = await tx.select().from(charactersTable).where(and(
      eq(charactersTable.id, params.data.id),
      eq(charactersTable.tenantId, tenantId),
    )).for("update");
    if (!character) return { kind: "character-missing" as const };
    const [asset] = await tx.select().from(characterAssetsTable).where(and(
      eq(characterAssetsTable.id, params.data.assetId),
      eq(characterAssetsTable.characterId, character.id),
    ));
    if (!asset) return { kind: "asset-missing" as const };
    // Job creation takes this same character row lock before persisting its
    // source snapshot. Never delete a source while a worker may still read it.
    const activeJobs = await tx.select({
      status: imageStudioJobsTable.status,
      referenceAssetIds: imageStudioJobsTable.referenceAssetIds,
      outputStorageKey: imageStudioJobsTable.outputStorageKey,
      providerTaskMetadata: imageStudioJobsTable.providerTaskMetadata,
    })
      .from(imageStudioJobsTable)
      .where(and(
        eq(imageStudioJobsTable.tenantId, tenantId),
        eq(imageStudioJobsTable.characterId, character.id),
        inArray(imageStudioJobsTable.status, ["QUEUED", "RUNNING"]),
      ));
    if (activeJobs.some((job) => characterAssetJobReferences(job, asset))) {
      return { kind: "referenced" as const };
    }
    const [deleted] = await tx.delete(characterAssetsTable).where(and(
      eq(characterAssetsTable.id, asset.id),
      eq(characterAssetsTable.characterId, character.id),
    )).returning();
    if (!deleted) return { kind: "asset-missing" as const };
    if (asset.isPrimary || character.thumbnail === `/api/media/${asset.storageKey}`) {
      await tx.update(charactersTable).set({ thumbnail: null }).where(eq(charactersTable.id, character.id));
    }
    const outputJobs = await tx.select({
      id: imageStudioJobsTable.id,
      providerTaskMetadata: imageStudioJobsTable.providerTaskMetadata,
    }).from(imageStudioJobsTable).where(and(
      eq(imageStudioJobsTable.tenantId, tenantId),
      eq(imageStudioJobsTable.characterId, character.id),
      eq(imageStudioJobsTable.outputStorageKey, asset.storageKey),
    ));
    for (const job of outputJobs) {
      await tx.update(imageStudioJobsTable).set({
        outputStorageKey: null,
        outputMimeType: null,
        providerTaskMetadata: {
          ...job.providerTaskMetadata,
          characterAssetId: null,
          outputAssetDeletedAt: new Date().toISOString(),
        },
      }).where(eq(imageStudioJobsTable.id, job.id));
    }
    await invalidateCharacterDossier(tenantId, character.id, tx);
    return { kind: "deleted" as const, asset: deleted };
  });
  if (result.kind === "character-missing") {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (result.kind === "asset-missing") {
    res.status(404).json({ error: "Character asset not found" });
    return;
  }
  if (result.kind === "referenced") {
    res.status(409).json({
      error: "Character image cannot be deleted while it is the source or output of a queued or running generation",
    });
    return;
  }
  await mediaStorage.deleteOutput(result.asset.storageKey);
  res.sendStatus(204);
});

router.post(
  "/characters/:id/voice-sample",
  express.raw({
    type: [
      "audio/wav",
      "audio/x-wav",
      "audio/wave",
      "audio/vnd.wave",
      "audio/mpeg",
      "audio/mp4",
      "audio/x-m4a",
      "audio/webm",
      "audio/ogg",
    ],
    limit: "30mb",
  }),
  async (req, res): Promise<void> => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (req.header("x-voice-consent") !== "confirmed") {
      res.status(400).json({ error: "Voice cloning permission must be confirmed" });
      return;
    }
    const [character] = await db.select().from(charactersTable).where(and(
      eq(charactersTable.id, id),
      eq(charactersTable.tenantId, req.context!.tenant!.id),
    ));
    if (!character) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "Send audio bytes directly with an audio Content-Type" });
      return;
    }
    const contentType = (req.header("content-type") ?? "").split(";")[0];
    const originalName = decodeURIComponent(req.header("x-file-name") ?? "voice-sample.wav");
    try {
      const stored = await mediaStorage.storeVoiceSample(originalName, contentType, req.body, req.context!.tenant!.id);
      const consentAt = new Date();
      await db
        .update(charactersTable)
        .set({
          voiceStorageKey: stored.key,
          voiceOriginalName: originalName.slice(0, 255),
          voiceMimeType: stored.mimeType,
          voiceConsentAt: consentAt,
        })
        .where(eq(charactersTable.id, character.id));
      if (character.voiceStorageKey && character.voiceStorageKey !== stored.key) {
        await mediaStorage.deleteVoiceSample(character.voiceStorageKey);
      }
      res.status(201).json({
        ok: true,
        voiceSampleUrl: `/api/media/${stored.key}`,
        voiceConsentAt: consentAt.toISOString(),
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Voice sample upload failed" });
    }
  },
);

router.delete("/characters/:id/voice-sample", async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [character] = await db.select().from(charactersTable).where(and(
    eq(charactersTable.id, id),
    eq(charactersTable.tenantId, req.context!.tenant!.id),
  ));
  if (!character) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  await db
    .update(charactersTable)
    .set({
      voiceStorageKey: null,
      voiceOriginalName: null,
      voiceMimeType: null,
      voiceConsentAt: null,
    })
    .where(eq(charactersTable.id, character.id));
  if (character.voiceStorageKey) await mediaStorage.deleteVoiceSample(character.voiceStorageKey);
  res.sendStatus(204);
});

export default router;
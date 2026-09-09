import { and, eq } from "drizzle-orm";
import express, { Router, type IRouter } from "express";
import {
  CreateCharacterBody,
  CreateCharacterResponse,
  DeleteCharacterParams,
  GenerateCharacterImageBody,
  GenerateCharacterImageParams,
  GenerateCharacterImageResponse,
  ListCharactersResponse,
  UpdateCharacterBody,
  UpdateCharacterParams,
  UpdateCharacterResponse,
} from "@workspace/api-zod";
import { characterAssetsTable, charactersTable, db } from "@workspace/db";
import { mediaStorage } from "../lib/storage-service";
import {
  generateStudioImage,
  StudioImageGenerationUnavailableError,
} from "../lib/studio-image-generation";
import { presentCharacter } from "../lib/studio-presenters";

const router: IRouter = Router();

async function list(tenantId: string) {
  const characters = await db.select().from(charactersTable).where(eq(charactersTable.tenantId, tenantId));
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
  const [character] = await db.update(charactersTable).set(input.data).where(and(
    eq(charactersTable.id, params.data.id),
    eq(charactersTable.tenantId, req.context!.tenant!.id),
  )).returning();
  if (!character) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  const assets = await db.select({ id: characterAssetsTable.id }).from(characterAssetsTable).where(eq(characterAssetsTable.characterId, character.id));
  res.json(UpdateCharacterResponse.parse(presentCharacter(character, assets.length)));
});

router.delete("/characters/:id", async (req, res): Promise<void> => {
  const params = DeleteCharacterParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db.delete(charactersTable).where(and(
    eq(charactersTable.id, params.data.id),
    eq(charactersTable.tenantId, req.context!.tenant!.id),
  )).returning();
  if (!deleted) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (deleted.voiceStorageKey) await mediaStorage.deleteVoiceSample(deleted.voiceStorageKey);
  res.sendStatus(204);
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
    const result = await generateStudioImage({
      kind: "character",
      entityId: params.data.id,
      tenantId: req.context!.tenant!.id,
      prompt: input.data.prompt,
      seed: input.data.seed,
    });
    res.status(201).json(GenerateCharacterImageResponse.parse(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Character image generation failed";
    const status = error instanceof StudioImageGenerationUnavailableError ? 503 : message === "Character not found" ? 404 : 400;
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
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "Send image bytes directly with an image Content-Type" });
    return;
  }
  try {
    const storageKey = await mediaStorage.storeImage(originalName, contentType, req.body, "characters", req.context!.tenant!.id);
    await db.insert(characterAssetsTable).values({
      characterId: character.id,
      storageKey,
      originalName: originalName.slice(0, 255),
      mimeType: contentType,
      angle: req.header("x-asset-label")?.slice(0, 120) ?? null,
      description: req.header("x-asset-description")?.slice(0, 500) ?? "",
    });
    res.status(201).json({ ok: true, mediaUrl: `/api/media/${storageKey}` });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Asset upload failed" });
  }
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
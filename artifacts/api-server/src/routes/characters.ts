import { eq } from "drizzle-orm";
import express, { Router, type IRouter } from "express";
import {
  CreateCharacterBody,
  CreateCharacterResponse,
  DeleteCharacterParams,
  ListCharactersResponse,
  UpdateCharacterBody,
  UpdateCharacterParams,
  UpdateCharacterResponse,
} from "@workspace/api-zod";
import { characterAssetsTable, charactersTable, db } from "@workspace/db";
import { mediaStorage } from "../lib/storage-service";
import { presentCharacter } from "../lib/studio-presenters";

const router: IRouter = Router();

async function list() {
  const characters = await db.select().from(charactersTable);
  return Promise.all(characters.map(async (character) => {
    const assets = await db.select({ id: characterAssetsTable.id }).from(characterAssetsTable).where(eq(characterAssetsTable.characterId, character.id));
    return presentCharacter(character, assets.length);
  }));
}

router.get("/characters", async (_req, res): Promise<void> => {
  res.json(ListCharactersResponse.parse(await list()));
});

router.post("/characters", async (req, res): Promise<void> => {
  const input = CreateCharacterBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  const [character] = await db.insert(charactersTable).values(input.data).returning();
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
  const [character] = await db.update(charactersTable).set(input.data).where(eq(charactersTable.id, params.data.id)).returning();
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
  const [deleted] = await db.delete(charactersTable).where(eq(charactersTable.id, params.data.id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/characters/:id/assets", express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "15mb" }), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [character] = await db.select().from(charactersTable).where(eq(charactersTable.id, id));
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
    const storageKey = await mediaStorage.storeImage(originalName, contentType, req.body, "characters");
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

export default router;
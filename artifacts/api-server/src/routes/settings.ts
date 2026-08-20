import express, { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  CreateSettingBody,
  CreateSettingResponse,
  DeleteSettingParams,
  ListSettingsResponse,
  UpdateSettingBody,
  UpdateSettingParams,
  UpdateSettingResponse,
} from "@workspace/api-zod";
import { db, settingAssetsTable, settingsTable } from "@workspace/db";
import { mediaStorage } from "../lib/storage-service";
import { presentSetting } from "../lib/studio-presenters";

const router: IRouter = Router();

async function list() {
  const settings = await db.select().from(settingsTable);
  return Promise.all(settings.map(async (setting) => {
    const assets = await db.select({ id: settingAssetsTable.id }).from(settingAssetsTable).where(eq(settingAssetsTable.settingId, setting.id));
    return presentSetting(setting, assets.length);
  }));
}

router.get("/settings", async (_req, res): Promise<void> => {
  res.json(ListSettingsResponse.parse(await list()));
});

router.post("/settings", async (req, res): Promise<void> => {
  const input = CreateSettingBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  const [setting] = await db.insert(settingsTable).values(input.data).returning();
  res.status(201).json(CreateSettingResponse.parse(presentSetting(setting, 0)));
});

router.patch("/settings/:id", async (req, res): Promise<void> => {
  const params = UpdateSettingParams.safeParse(req.params);
  const input = UpdateSettingBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  const [setting] = await db.update(settingsTable).set(input.data).where(eq(settingsTable.id, params.data.id)).returning();
  if (!setting) {
    res.status(404).json({ error: "Setting not found" });
    return;
  }
  const assets = await db.select({ id: settingAssetsTable.id }).from(settingAssetsTable).where(eq(settingAssetsTable.settingId, setting.id));
  res.json(UpdateSettingResponse.parse(presentSetting(setting, assets.length)));
});

router.delete("/settings/:id", async (req, res): Promise<void> => {
  const params = DeleteSettingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db.delete(settingsTable).where(eq(settingsTable.id, params.data.id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Setting not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/settings/:id/assets", express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "15mb" }), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [setting] = await db.select().from(settingsTable).where(eq(settingsTable.id, id));
  if (!setting) {
    res.status(404).json({ error: "Setting not found" });
    return;
  }
  const contentType = req.header("content-type") ?? "";
  const originalName = req.header("x-file-name") ?? "setting-reference";
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "Send image bytes directly with an image Content-Type" });
    return;
  }
  try {
    const storageKey = await mediaStorage.storeImage(originalName, contentType, req.body, "settings");
    await db.insert(settingAssetsTable).values({
      settingId: setting.id,
      storageKey,
      originalName: originalName.slice(0, 255),
      mimeType: contentType,
      description: req.header("x-asset-description")?.slice(0, 500) ?? "",
    });
    res.status(201).json({ ok: true, mediaUrl: `/api/media/${storageKey}` });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Asset upload failed" });
  }
});

export default router;
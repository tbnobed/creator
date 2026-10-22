import express, { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { CreateImageStudioJobBody } from "@workspace/api-zod";
import { createImageJob, inspectImage, ImageStudioRequestError } from "../lib/image-studio-service";
import { imageStudioAssetsTable, imageStudioJobsTable } from "@workspace/db";
import {
  CreateSettingBody,
  CreateSettingResponse,
  DeleteSettingParams,
  GenerateSettingImageBody,
  GenerateSettingImageParams,
  GenerateSettingImageResponse,
  ListSettingsResponse,
  UpdateSettingBody,
  UpdateSettingParams,
  UpdateSettingResponse,
} from "@workspace/api-zod";
import { db, settingAssetsTable, settingsTable } from "@workspace/db";
import { mediaStorage } from "../lib/storage-service";
import {
  generateStudioImage,
  StudioImageGenerationUnavailableError,
} from "../lib/studio-image-generation";
import { presentSetting } from "../lib/studio-presenters";
import { reconcileSceneryLibrary, sceneryReferenceId, sceneryUsedByProjects } from "../lib/scenery-library";

const router: IRouter = Router();

async function list(tenantId: string) {
  await reconcileSceneryLibrary(tenantId);
  const settings = await db.select().from(settingsTable).where(eq(settingsTable.tenantId, tenantId));
  return Promise.all(settings.map(async (setting) => {
    const assets = await db.select().from(settingAssetsTable).where(eq(settingAssetsTable.settingId, setting.id));
    return { ...presentSetting(setting, assets.length), references: await Promise.all(assets.sort((a, b) => a.sortOrder - b.sortOrder).map(async asset => {
      let unavailableReason: string | undefined;
      let imageAssetId = (await db.select({ id: imageStudioAssetsTable.id }).from(imageStudioAssetsTable).where(and(
        eq(imageStudioAssetsTable.tenantId, tenantId), eq(imageStudioAssetsTable.storageKey, asset.storageKey),
      )).limit(1))[0]?.id;
      if (!imageAssetId) {
        let metadata: ReturnType<typeof inspectImage> | undefined;
        try { metadata = inspectImage(await mediaStorage.readBuffer(asset.storageKey), asset.mimeType); }
        catch { unavailableReason = "Reference file unavailable. Restore or replace the image before creating variants."; }
        if (metadata) {
          imageAssetId = sceneryReferenceId(setting.id, `image:${asset.id}`);
          await db.insert(imageStudioAssetsTable).values({
            id: imageAssetId, tenantId, createdByUserId: setting.createdByUserId,
            name: asset.originalName, storageKey: asset.storageKey, ...metadata,
          }).onConflictDoNothing();
        }
      }
      return { imageAssetId, unavailableReason, id: asset.id, name: asset.originalName, url: `/api/media/${asset.storageKey}`, prompt: asset.description };
    })) };
  }));
}

router.get("/settings", async (req, res): Promise<void> => {
  res.json(ListSettingsResponse.parse(await list(req.context!.tenant!.id)));
});

router.post("/settings", async (req, res): Promise<void> => {
  const input = CreateSettingBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  const [setting] = await db.insert(settingsTable).values({
    ...input.data,
    tenantId: req.context!.tenant!.id,
    createdByUserId: req.context!.user.id,
  }).returning();
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
  const [setting] = await db.update(settingsTable).set(input.data).where(and(
    eq(settingsTable.id, params.data.id),
    eq(settingsTable.tenantId, req.context!.tenant!.id),
  )).returning();
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
  if (await sceneryUsedByProjects(req.context!.tenant!.id, params.data.id)) {
    res.status(409).json({ error: "This location is used by a production. Remove it from those projects before deleting it from the library." });
    return;
  }
  const [activeJob] = await db.select({ id: imageStudioJobsTable.id }).from(imageStudioJobsTable).where(and(
    eq(imageStudioJobsTable.tenantId, req.context!.tenant!.id),
    eq(imageStudioJobsTable.settingId, params.data.id),
    inArray(imageStudioJobsTable.status, ["QUEUED", "RUNNING"]),
  )).limit(1);
  if (activeJob) {
    res.status(409).json({ error: "This location has an active image job. Cancel it in Queue & History or wait for it to finish before deleting the location." }); return;
  }
  const [deleted] = await db.delete(settingsTable).where(and(
    eq(settingsTable.id, params.data.id),
    eq(settingsTable.tenantId, req.context!.tenant!.id),
  )).returning();
  if (!deleted) {
    res.status(404).json({ error: "Setting not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/settings/:id/image-jobs", async (req, res): Promise<void> => {
  const params = GenerateSettingImageParams.safeParse(req.params);
  const input = CreateImageStudioJobBody.safeParse(req.body);
  if (!params.success || !input.success) { res.status(400).json({ error: "Invalid location image request" }); return; }
  const tenantId = req.context!.tenant!.id;
  const [owned] = await db.select().from(settingsTable).where(and(eq(settingsTable.id, params.data.id), eq(settingsTable.tenantId, tenantId)));
  if (!owned) { res.status(404).json({ error: "Location not found" }); return; }
  if (!["generate", "edit"].includes(input.data.operation) || input.data.count !== 1 || !input.data.requestKey) {
    res.status(400).json({ error: "Location generation requires a single image and a request key." }); return;
  }
  const referenceName = typeof req.body.referenceName === "string" ? req.body.referenceName.trim().slice(0, 180) : "Base";
  try {
    const job = await createImageJob({
      tenantId, userId: req.context!.user.id, request: input.data,
      settingId: owned.id, settingReferenceName: referenceName || "Base",
    });
    res.status(202).json(job);
  } catch (error) {
    res.status(error instanceof ImageStudioRequestError ? error.status : 500).json({ error: error instanceof Error ? error.message : "Location generation failed" });
  }
});

router.patch("/settings/:id/references/:referenceId", async (req, res): Promise<void> => {
  const tenantId = req.context!.tenant!.id;
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id) || !/^[0-9a-f-]{36}$/i.test(req.params.referenceId)) { res.status(400).json({ error: "Invalid reference" }); return; }
  const [owned] = await db.select().from(settingsTable).where(and(eq(settingsTable.id, req.params.id), eq(settingsTable.tenantId, tenantId)));
  if (!owned) { res.status(404).json({ error: "Location not found" }); return; }
  const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 180) : "";
  if (!name) { res.status(400).json({ error: "Reference name is required" }); return; }
  const rows = await db.update(settingAssetsTable).set({ originalName: name }).where(and(eq(settingAssetsTable.id, req.params.referenceId), eq(settingAssetsTable.settingId, owned.id))).returning();
  if (!rows.length) { res.status(404).json({ error: "Reference not found" }); return; }
  res.json({ ok: true });
});

router.delete("/settings/:id/references/:referenceId", async (req, res): Promise<void> => {
  const tenantId = req.context!.tenant!.id;
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id) || !/^[0-9a-f-]{36}$/i.test(req.params.referenceId)) { res.status(400).json({ error: "Invalid reference" }); return; }
  const [owned] = await db.select().from(settingsTable).where(and(eq(settingsTable.id, req.params.id), eq(settingsTable.tenantId, tenantId)));
  if (!owned) { res.status(404).json({ error: "Location not found" }); return; }
  if (await sceneryUsedByProjects(tenantId, owned.id)) { res.status(409).json({ error: "This location is used in a production. Remove its production assignments before deleting shared references." }); return; }
  await db.transaction(async tx => {
    const [asset] = await tx.delete(settingAssetsTable).where(and(eq(settingAssetsTable.id, req.params.referenceId), eq(settingAssetsTable.settingId, owned.id))).returning();
    if (!asset) return;
    const images = await tx.select().from(imageStudioAssetsTable).where(and(eq(imageStudioAssetsTable.storageKey, asset.storageKey), eq(imageStudioAssetsTable.tenantId, tenantId)));
    for (const image of images) if (image.jobId) await tx.update(imageStudioJobsTable).set({ settingId: null }).where(and(eq(imageStudioJobsTable.id, image.jobId), eq(imageStudioJobsTable.settingId, owned.id)));
    const refs = await tx.select().from(settingAssetsTable).where(eq(settingAssetsTable.settingId, owned.id));
    if (owned.thumbnail === `/api/media/${asset.storageKey}`) await tx.update(settingsTable).set({ thumbnail: refs[0] ? `/api/media/${refs[0].storageKey}` : null }).where(eq(settingsTable.id, owned.id));
  });
  res.json({ ok: true });
});

router.post("/settings/:id/generate-image", async (req, res): Promise<void> => {
  const params = GenerateSettingImageParams.safeParse(req.params);
  const input = GenerateSettingImageBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  try {
    const [owned] = await db.select({ id: settingsTable.id }).from(settingsTable).where(and(
      eq(settingsTable.id, params.data.id),
      eq(settingsTable.tenantId, req.context!.tenant!.id),
    ));
    if (!owned) {
      res.status(404).json({ error: "Setting not found" });
      return;
    }
    const result = await generateStudioImage({
      kind: "setting",
      entityId: params.data.id,
      tenantId: req.context!.tenant!.id,
      prompt: input.data.prompt,
      seed: input.data.seed,
    });
    res.status(201).json(GenerateSettingImageResponse.parse(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Setting image generation failed";
    const status = error instanceof StudioImageGenerationUnavailableError ? 503 : message === "Setting not found" ? 404 : 400;
    res.status(status).json({ error: message });
  }
});

router.post("/settings/:id/assets", express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "15mb" }), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [setting] = await db.select().from(settingsTable).where(and(
    eq(settingsTable.id, id),
    eq(settingsTable.tenantId, req.context!.tenant!.id),
  ));
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
    const storageKey = await mediaStorage.storeImage(originalName, contentType, req.body, "settings", req.context!.tenant!.id);
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
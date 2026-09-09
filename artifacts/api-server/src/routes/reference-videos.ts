import express, { Router, type IRouter } from "express";
import { mediaStorage } from "../lib/storage-service";

const router: IRouter = Router();

router.delete("/reference-videos/:name", async (req, res): Promise<void> => {
  const name = typeof req.params.name === "string" ? req.params.name : "";
  if (!/^[a-z0-9_-]+\.(mp4|webm)$/i.test(name)) {
    res.status(400).json({ error: "Invalid reference video" });
    return;
  }

  try {
    let deleted = await mediaStorage.deleteReferenceVideo(`tenants/${req.context!.tenant!.id}/reference-videos/${name}`);
    if (!deleted && req.context!.tenant!.isDefault) {
      deleted = await mediaStorage.deleteReferenceVideo(`reference-videos/${name}`);
    }
    if (!deleted) {
      res.status(404).json({ error: "Reference video not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    req.log.error({ err: error, name }, "Reference video could not be deleted");
    res.status(404).json({ error: "Reference video not found" });
  }
});

router.get("/reference-videos", async (req, res): Promise<void> => {
  try {
    const items = await mediaStorage.listReferenceVideos(
      req.context!.tenant!.id,
      req.context!.tenant!.isDefault,
    );
    res.json({
      items: items.map((item) => ({
        ...item,
        mediaUrl: `/api/media/${item.storageKey}`,
        previewUrl: `/api/media-preview/${item.storageKey}`,
      })),
    });
  } catch (error) {
    req.log.error({ err: error }, "Reference video library could not be loaded");
    res.status(500).json({ error: "Reference video library could not be loaded" });
  }
});

router.post(
  "/reference-videos",
  express.raw({ type: ["video/mp4", "video/webm"], limit: "250mb" }),
  async (req, res): Promise<void> => {
    const mimeType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
    const originalName = req.headers["x-file-name"];
    const filename = typeof originalName === "string" && originalName.trim()
      ? originalName.trim()
      : "reference-video";

    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "Reference video data is required" });
      return;
    }

    try {
      const storageKey = await mediaStorage.storeReferenceVideo(filename, mimeType, req.body, req.context!.tenant!.id);
      res.status(201).json({
        storageKey,
        mediaUrl: `/api/media/${storageKey}`,
        mimeType,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Reference video upload failed",
      });
    }
  },
);

export default router;
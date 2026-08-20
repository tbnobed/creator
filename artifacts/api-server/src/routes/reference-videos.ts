import express, { Router, type IRouter } from "express";
import { mediaStorage } from "../lib/storage-service";

const router: IRouter = Router();

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
      const storageKey = await mediaStorage.storeReferenceVideo(filename, mimeType, req.body);
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
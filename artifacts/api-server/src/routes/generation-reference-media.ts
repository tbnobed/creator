import express, { Router, type IRouter } from "express";
import { UploadGenerationReferenceMediaResponse } from "@workspace/api-zod";
import { mediaStorage } from "../lib/storage-service";

const router: IRouter = Router();
const acceptedTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
];

router.post(
  "/generations/reference-media",
  express.raw({ type: acceptedTypes, limit: "200mb" }),
  async (req, res): Promise<void> => {
    const mimeType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!acceptedTypes.includes(mimeType)) {
      res.status(415).json({ error: "Unsupported reference media MIME type" });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "Reference media bytes are required" });
      return;
    }
    try {
      const storageKey = await mediaStorage.storeGenerationReferenceMedia(
        mimeType,
        req.body,
        req.context!.tenant!.id,
      );
      res.status(201).json(UploadGenerationReferenceMediaResponse.parse({
        storageKey,
        mediaUrl: `/api/media/${storageKey}`,
        mimeType,
      }));
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Reference media upload failed",
      });
    }
  },
);

export default router;
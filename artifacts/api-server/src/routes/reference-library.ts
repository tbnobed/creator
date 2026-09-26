import { Router, type IRouter } from "express";
import { importReference, listReferenceLibrary, ReferenceLibraryError } from "../lib/reference-library-service";

const router: IRouter = Router();
const kinds = ["image", "video", "audio"] as const;
const roles = ["referenceImage", "firstFrame", "lastFrame", "referenceVideo", "referenceAudio"] as const;
const sourceTypes = ["upload", "generation", "imageAsset", "characterAsset", "settingAsset", "referenceVideo"] as const;
function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.some((item) => item === value);
}

router.get("/reference-library", async (req, res) => {
  const { kind, role } = req.query;
  if ((kind !== undefined && !member(kind, kinds)) || (role !== undefined && !member(role, roles))) {
    res.status(400).json({ error: "Invalid reference kind or role" }); return;
  }
  try {
    res.json({ items: await listReferenceLibrary(req.context!.tenant!.id, kind, role) });
  } catch (error) {
    req.log.error({ err: error }, "Reference library could not be loaded");
    res.status(500).json({ error: "Reference library could not be loaded" });
  }
});

router.post("/reference-library/import", async (req, res) => {
  const { sourceType, sourceId, role } = req.body ?? {};
  if (!member(sourceType, sourceTypes) || typeof sourceId !== "string" || !sourceId || sourceId.length > 255
    || (role !== undefined && !member(role, roles))) {
    res.status(400).json({ error: "Invalid reference source or role" }); return;
  }
  try {
    res.status(201).json(await importReference(req.context!.tenant!.id, sourceType, sourceId, role));
  } catch (error) {
    if (!(error instanceof ReferenceLibraryError)) req.log.error({ err: error }, "Reference import failed");
    res.status(error instanceof ReferenceLibraryError ? error.status : 500).json({
      error: error instanceof Error ? error.message : "Reference import failed",
    });
  }
});

export default router;
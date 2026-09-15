import express, {
  Router,
  type ErrorRequestHandler,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  CancelImageStudioJobParams,
  CancelImageStudioJobResponse,
  CreateImageStudioJobBody,
  CreateImageStudioJobResponse,
  DeleteImageStudioAssetParams,
  DeleteImageStudioJobParams,
  GetImageStudioJobParams,
  GetImageStudioJobResponse,
  ListImageStudioAssetsQueryParams,
  ListImageStudioAssetsResponse,
  ListImageStudioJobsQueryParams,
  ListImageStudioJobsResponse,
  ListImageStudioModelsResponse,
  UpdateImageStudioAssetBody,
  UpdateImageStudioAssetParams,
  UpdateImageStudioAssetResponse,
  UploadImageStudioAssetResponse,
} from "@workspace/api-zod";
import {
  ImageStudioRequestError,
  cancelImageJob,
  createImageJob,
  createUploadedAsset,
  deleteImageAsset,
  deleteImageJob,
  getImageJob,
  listImageAssets,
  listImageJobs,
  listImageModels,
  updateImageAsset,
} from "../lib/image-studio-service";

const router: IRouter = Router();
const imageBody = express.raw({
  type: ["image/png", "image/jpeg", "image/webp"],
  limit: "15mb",
});

function idParams(req: Request): Record<string, string | string[]> {
  return req.params as Record<string, string | string[]>;
}

function respondError(req: Request, res: Response, error: unknown): void {
  if (error instanceof ImageStudioRequestError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (
    error
    && typeof error === "object"
    && typeof (error as { statusCode?: unknown }).statusCode === "number"
  ) {
    const statusCode = (error as { statusCode: number }).statusCode;
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
      res.status(statusCode).json({
        error: error instanceof Error ? error.message : "Image Studio request was rejected",
      });
      return;
    }
  }
  req.log.error({ err: error }, "Image Studio request failed");
  res.status(500).json({ error: "Image Studio could not complete the request" });
}

router.get("/image-studio/models", async (req, res): Promise<void> => {
  try {
    res.json(ListImageStudioModelsResponse.parse({ models: await listImageModels() }));
  } catch (error) {
    respondError(req, res, error);
  }
});

router.get("/image-studio/jobs", async (req, res): Promise<void> => {
  const query = ListImageStudioJobsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (!Number.isSafeInteger(query.data.limit)) {
    res.status(400).json({ error: "Limit must be a whole number" });
    return;
  }
  try {
    res.json(ListImageStudioJobsResponse.parse({
      jobs: await listImageJobs(req.context!.tenant!.id, query.data.limit),
    }));
  } catch (error) {
    respondError(req, res, error);
  }
});

router.post("/image-studio/jobs", async (req, res): Promise<void> => {
  const body = CreateImageStudioJobBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const job = await createImageJob({
      tenantId: req.context!.tenant!.id,
      userId: req.context!.user.id,
      request: body.data,
    });
    res.status(202).json(CreateImageStudioJobResponse.parse({ job }));
  } catch (error) {
    respondError(req, res, error);
  }
});

router.get("/image-studio/jobs/:id", async (req, res): Promise<void> => {
  const params = GetImageStudioJobParams.safeParse(idParams(req));
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const job = await getImageJob(req.context!.tenant!.id, params.data.id);
    if (!job) {
      res.status(404).json({ error: "Image job not found" });
      return;
    }
    res.json(GetImageStudioJobResponse.parse({ job }));
  } catch (error) {
    respondError(req, res, error);
  }
});

router.post("/image-studio/jobs/:id/cancel", async (req, res): Promise<void> => {
  const params = CancelImageStudioJobParams.safeParse(idParams(req));
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const job = await cancelImageJob(req.context!.tenant!.id, params.data.id);
    if (!job) {
      res.status(404).json({ error: "Image job not found" });
      return;
    }
    res.json(CancelImageStudioJobResponse.parse({ job }));
  } catch (error) {
    respondError(req, res, error);
  }
});

router.delete("/image-studio/jobs/:id", async (req, res): Promise<void> => {
  const params = DeleteImageStudioJobParams.safeParse(idParams(req));
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const result = await deleteImageJob(req.context!.tenant!.id, params.data.id);
    if (result === "missing") {
      res.status(404).json({ error: "Image job not found" });
      return;
    }
    if (result === "active") {
      res.status(409).json({ error: "Cancel the active image job before deleting it" });
      return;
    }
    res.sendStatus(204);
  } catch (error) {
    respondError(req, res, error);
  }
});

router.get("/image-studio/assets", async (req, res): Promise<void> => {
  const rawFavorite = req.query.favorite;
  if (
    rawFavorite !== undefined
    && rawFavorite !== "true"
    && rawFavorite !== "false"
  ) {
    res.status(400).json({ error: "Favorite must be true or false" });
    return;
  }
  const query = ListImageStudioAssetsQueryParams.safeParse({
    ...req.query,
    ...(rawFavorite === undefined ? {} : { favorite: rawFavorite === "true" }),
  });
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  try {
    res.json(ListImageStudioAssetsResponse.parse({
      assets: await listImageAssets({
        tenantId: req.context!.tenant!.id,
        ...query.data,
      }),
    }));
  } catch (error) {
    respondError(req, res, error);
  }
});

router.post("/image-studio/uploads", imageBody, async (req, res): Promise<void> => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: "Upload a PNG, JPEG, or WebP image as the raw request body" });
    return;
  }
  const mimeType = req.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mimeType || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    res.status(415).json({ error: "Only PNG, JPEG, and WebP images are supported" });
    return;
  }
  const suppliedName = req.get("x-file-name")?.trim();
  const name = suppliedName && !/[/\\\0]/.test(suppliedName)
    ? suppliedName
    : `Image upload ${new Date().toISOString()}`;
  try {
    const asset = await createUploadedAsset({
      tenantId: req.context!.tenant!.id,
      userId: req.context!.user.id,
      name,
      mimeType,
      bytes: req.body,
    });
    res.status(201).json(UploadImageStudioAssetResponse.parse({ asset }));
  } catch (error) {
    respondError(req, res, error);
  }
});

router.patch("/image-studio/assets/:id", async (req, res): Promise<void> => {
  const params = UpdateImageStudioAssetParams.safeParse(idParams(req));
  const body = UpdateImageStudioAssetBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (Object.keys(body.data).length === 0) {
    res.status(400).json({ error: "Provide favorite, collection, or name to update" });
    return;
  }
  if (body.data.name !== undefined && !body.data.name.trim()) {
    res.status(400).json({ error: "Asset name cannot be blank" });
    return;
  }
  try {
    const asset = await updateImageAsset({
      tenantId: req.context!.tenant!.id,
      id: params.data.id,
      ...body.data,
    });
    if (!asset) {
      res.status(404).json({ error: "Image asset not found" });
      return;
    }
    res.json(UpdateImageStudioAssetResponse.parse({ asset }));
  } catch (error) {
    respondError(req, res, error);
  }
});

router.delete("/image-studio/assets/:id", async (req, res): Promise<void> => {
  const params = DeleteImageStudioAssetParams.safeParse(idParams(req));
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const result = await deleteImageAsset(req.context!.tenant!.id, params.data.id);
    if (result === "missing") {
      res.status(404).json({ error: "Image asset not found" });
      return;
    }
    if (result === "referenced") {
      res.status(409).json({ error: "This image is still used by a job, continuity record, or character wardrobe" });
      return;
    }
    res.sendStatus(204);
  } catch (error) {
    respondError(req, res, error);
  }
});

const imageUploadErrorHandler: ErrorRequestHandler = (error, req, res, _next): void => {
  if (
    error
    && typeof error === "object"
    && (error as { type?: unknown }).type === "entity.too.large"
  ) {
    res.status(413).json({ error: "Image must not exceed 15 MB" });
    return;
  }
  req.log.error({ err: error }, "Image upload body could not be read");
  res.status(400).json({ error: "The image upload body could not be read" });
};
router.use(imageUploadErrorHandler);

export default router;
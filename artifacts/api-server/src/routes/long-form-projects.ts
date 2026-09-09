import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CancelLongFormProjectParams,
  CancelLongFormProjectResponse,
  CreateLongFormProjectBody,
  CreateLongFormProjectResponse,
  DeleteLongFormProjectParams,
  GetLongFormProjectParams,
  GetLongFormProjectResponse,
  ListLongFormProjectsResponse,
  PauseLongFormProjectParams,
  PauseLongFormProjectResponse,
  ReassembleLongFormProjectParams,
  ReassembleLongFormProjectResponse,
  RetryLongFormShotParams,
  RetryLongFormShotResponse,
  StartLongFormProjectParams,
  StartLongFormProjectResponse,
  UpdateLongFormShotBody,
  UpdateLongFormShotParams,
  UpdateLongFormShotResponse,
  UpdateLongFormTimelineBody,
  UpdateLongFormTimelineParams,
  UpdateLongFormTimelineResponse,
  DownloadLongFormNlePackageParams,
} from "@workspace/api-zod";
import { db, longFormProjectsTable, longFormShotsTable } from "@workspace/db";
import {
  cancelLongFormProject,
  createLongFormNlePackage,
  createLongFormProject,
  deleteLongFormProject,
  pauseLongFormProject,
  presentLongFormProject,
  reassembleLongFormProject,
  retryLongFormShot,
  startLongFormProject,
  updateLongFormShot,
  updateLongFormTimeline,
} from "../lib/long-form-service";
import { ResourceNotFoundError } from "../lib/resource-errors";

const router: IRouter = Router();

async function detail(projectId: string, tenantId: string) {
  const [project] = await db.select().from(longFormProjectsTable).where(and(
    eq(longFormProjectsTable.id, projectId),
    eq(longFormProjectsTable.tenantId, tenantId),
  ));
  return project ? presentLongFormProject(project, true) : null;
}

router.get("/long-form-projects", async (req, res): Promise<void> => {
  const projects = await db.select().from(longFormProjectsTable)
    .where(eq(longFormProjectsTable.tenantId, req.context!.tenant!.id))
    .orderBy(desc(longFormProjectsTable.createdAt));
  res.json(ListLongFormProjectsResponse.parse(await Promise.all(projects.map((project) => presentLongFormProject(project)))));
});

router.post("/long-form-projects", async (req, res): Promise<void> => {
  const input = CreateLongFormProjectBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  try {
    res.status(201).json(CreateLongFormProjectResponse.parse(await createLongFormProject({
      ...input.data,
      tenantId: req.context!.tenant!.id,
      createdByUserId: req.context!.user.id,
    })));
  } catch (error) {
    res.status(error instanceof ResourceNotFoundError ? 404 : 400).json({
      error: error instanceof Error ? error.message : "Could not plan long-form project",
    });
  }
});

router.use("/long-form-projects/:id", async (req, res, next): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [owned] = await db.select({ id: longFormProjectsTable.id }).from(longFormProjectsTable).where(and(
    eq(longFormProjectsTable.id, id),
    eq(longFormProjectsTable.tenantId, req.context!.tenant!.id),
  ));
  if (!owned) {
    res.status(404).json({ error: "Long-form project not found" });
    return;
  }
  next();
});

router.use("/long-form-projects/:id/shots/:shotId", async (req, res, next): Promise<void> => {
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const shotId = Array.isArray(req.params.shotId) ? req.params.shotId[0] : req.params.shotId;
  const [shot] = await db.select({ id: longFormShotsTable.id }).from(longFormShotsTable).where(and(
    eq(longFormShotsTable.id, shotId),
    eq(longFormShotsTable.projectId, projectId),
  ));
  if (!shot) {
    res.status(404).json({ error: "Long-form shot not found" });
    return;
  }
  next();
});

router.get("/long-form-projects/:id", async (req, res): Promise<void> => {
  const params = GetLongFormProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const project = await detail(params.data.id, req.context!.tenant!.id);
  if (!project) {
    res.status(404).json({ error: "Long-form project not found" });
    return;
  }
  res.json(GetLongFormProjectResponse.parse(project));
});

router.delete("/long-form-projects/:id", async (req, res): Promise<void> => {
  const params = DeleteLongFormProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    await deleteLongFormProject(params.data.id);
    res.sendStatus(204);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not delete long-form project";
    const status = message === "Long-form project not found" ? 404 : 409;
    res.status(status).json({ error: message });
  }
});

router.post("/long-form-projects/:id/start", async (req, res): Promise<void> => {
  const params = StartLongFormProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    res.json(StartLongFormProjectResponse.parse(await startLongFormProject(params.data.id)));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Could not start project" });
  }
});

router.post("/long-form-projects/:id/reassemble", async (req, res): Promise<void> => {
  const params = ReassembleLongFormProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    res.json(ReassembleLongFormProjectResponse.parse(await reassembleLongFormProject(params.data.id)));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Could not reassemble project" });
  }
});

router.post("/long-form-projects/:id/pause", async (req, res): Promise<void> => {
  const params = PauseLongFormProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    res.json(PauseLongFormProjectResponse.parse(await pauseLongFormProject(params.data.id)));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Could not pause project" });
  }
});

router.post("/long-form-projects/:id/cancel", async (req, res): Promise<void> => {
  const params = CancelLongFormProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    res.json(CancelLongFormProjectResponse.parse(await cancelLongFormProject(params.data.id)));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Could not cancel project" });
  }
});

router.patch("/long-form-projects/:id/shots/:shotId", async (req, res): Promise<void> => {
  const params = UpdateLongFormShotParams.safeParse(req.params);
  const input = UpdateLongFormShotBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  try {
    res.json(UpdateLongFormShotResponse.parse(await updateLongFormShot(params.data.id, params.data.shotId, input.data)));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Could not update shot" });
  }
});

router.post("/long-form-projects/:id/shots/:shotId/retry", async (req, res): Promise<void> => {
  const params = RetryLongFormShotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    res.json(RetryLongFormShotResponse.parse(await retryLongFormShot(params.data.id, params.data.shotId)));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Could not retry shot" });
  }
});

router.patch("/long-form-projects/:id/timeline", async (req, res): Promise<void> => {
  const params = UpdateLongFormTimelineParams.safeParse(req.params);
  const input = UpdateLongFormTimelineBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  try {
    res.json(UpdateLongFormTimelineResponse.parse(await updateLongFormTimeline(params.data.id, input.data)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update timeline";
    res.status(error instanceof ResourceNotFoundError ? 404 : 409).json({ error: message });
  }
});

router.get("/long-form-projects/:id/nle-package", async (req, res): Promise<void> => {
  const params = DownloadLongFormNlePackageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const bundle = await createLongFormNlePackage(params.data.id);
    const fileInfo = await stat(bundle.filePath);
    res.set({
      "content-disposition": `attachment; filename="${bundle.filename}"`,
      "content-length": String(fileInfo.size),
      "content-type": "application/zip",
      "cache-control": "no-store",
    });
    const cleanup = () => {
      void rm(bundle.filePath, { force: true }).catch((error) => {
        req.log.warn({ err: error, projectId: params.data.id }, "Could not remove temporary NLE package");
      });
    };
    res.once("close", cleanup);
    const stream = createReadStream(bundle.filePath);
    stream.on("error", (error) => {
      req.log.error({ err: error, projectId: params.data.id }, "Could not stream NLE package");
      if (!res.headersSent) res.status(500).json({ error: "Could not download NLE package" });
      else res.destroy(error);
    });
    stream.pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create NLE package";
    res.status(message === "Long-form project not found" ? 404 : 409).json({ error: message });
  }
});

export default router;
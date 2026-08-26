import { desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CancelLongFormProjectParams,
  CancelLongFormProjectResponse,
  CreateLongFormProjectBody,
  CreateLongFormProjectResponse,
  GetLongFormProjectParams,
  GetLongFormProjectResponse,
  ListLongFormProjectsResponse,
  PauseLongFormProjectParams,
  PauseLongFormProjectResponse,
  RetryLongFormShotParams,
  RetryLongFormShotResponse,
  StartLongFormProjectParams,
  StartLongFormProjectResponse,
  UpdateLongFormShotBody,
  UpdateLongFormShotParams,
  UpdateLongFormShotResponse,
} from "@workspace/api-zod";
import { db, longFormProjectsTable } from "@workspace/db";
import {
  cancelLongFormProject,
  createLongFormProject,
  pauseLongFormProject,
  presentLongFormProject,
  retryLongFormShot,
  startLongFormProject,
  updateLongFormShot,
} from "../lib/long-form-service";

const router: IRouter = Router();

async function detail(projectId: string) {
  const [project] = await db.select().from(longFormProjectsTable).where(eq(longFormProjectsTable.id, projectId));
  return project ? presentLongFormProject(project, true) : null;
}

router.get("/long-form-projects", async (_req, res): Promise<void> => {
  const projects = await db.select().from(longFormProjectsTable).orderBy(desc(longFormProjectsTable.createdAt));
  res.json(ListLongFormProjectsResponse.parse(await Promise.all(projects.map((project) => presentLongFormProject(project)))));
});

router.post("/long-form-projects", async (req, res): Promise<void> => {
  const input = CreateLongFormProjectBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  try {
    res.status(201).json(CreateLongFormProjectResponse.parse(await createLongFormProject(input.data)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not plan long-form project" });
  }
});

router.get("/long-form-projects/:id", async (req, res): Promise<void> => {
  const params = GetLongFormProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const project = await detail(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Long-form project not found" });
    return;
  }
  res.json(GetLongFormProjectResponse.parse(project));
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

export default router;
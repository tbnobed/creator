import { count, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateGenerationBody,
  CreateGenerationResponse,
  GetDashboardSummaryResponse,
  GetGenerationParams,
  GetGenerationResponse,
  ListGenerationsResponse,
  ListGenerationsQueryParams,
} from "@workspace/api-zod";
import {
  charactersTable,
  comfyServersTable,
  db,
  generationJobsTable,
  longFormProjectsTable,
  longFormShotsTable,
  settingsTable,
  workflowTemplatesTable,
} from "@workspace/db";
import { cancelGeneration, createAndSubmitGeneration, recoverTimedOutGeneration } from "../lib/generation-service";
import { presentGeneration } from "../lib/studio-presenters";
import { mediaStorage } from "../lib/storage-service";

const router: IRouter = Router();

async function present(job: typeof generationJobsTable.$inferSelect) {
  const [server, workflow, longFormContext] = await Promise.all([
    job.comfyServerId ? db.select({ displayName: comfyServersTable.displayName }).from(comfyServersTable).where(eq(comfyServersTable.id, job.comfyServerId)) : [],
    job.workflowTemplateId ? db.select({ name: workflowTemplatesTable.name }).from(workflowTemplatesTable).where(eq(workflowTemplatesTable.id, job.workflowTemplateId)) : [],
    job.longFormShotId
      ? db
        .select({
          projectId: longFormProjectsTable.id,
          projectTitle: longFormProjectsTable.title,
          sceneNumber: longFormShotsTable.sceneNumber,
          shotNumber: longFormShotsTable.shotNumber,
        })
        .from(longFormShotsTable)
        .innerJoin(longFormProjectsTable, eq(longFormProjectsTable.id, longFormShotsTable.projectId))
        .where(eq(longFormShotsTable.id, job.longFormShotId))
        .limit(1)
      : [],
  ]);
  return presentGeneration(job, server[0]?.displayName ?? null, workflow[0]?.name ?? null, longFormContext[0] ?? null);
}

async function presentMany(jobs: Array<typeof generationJobsTable.$inferSelect>) {
  const serverIds = [...new Set(jobs.map((job) => job.comfyServerId).filter((id): id is string => Boolean(id)))];
  const workflowIds = [...new Set(jobs.map((job) => job.workflowTemplateId).filter((id): id is string => Boolean(id)))];
  const shotIds = [...new Set(jobs.map((job) => job.longFormShotId).filter((id): id is string => Boolean(id)))];
  const [servers, workflows, longFormContexts] = await Promise.all([
    serverIds.length
      ? db.select({ id: comfyServersTable.id, displayName: comfyServersTable.displayName }).from(comfyServersTable).where(inArray(comfyServersTable.id, serverIds))
      : [],
    workflowIds.length
      ? db.select({ id: workflowTemplatesTable.id, name: workflowTemplatesTable.name }).from(workflowTemplatesTable).where(inArray(workflowTemplatesTable.id, workflowIds))
      : [],
    shotIds.length
      ? db
        .select({
          shotId: longFormShotsTable.id,
          projectId: longFormProjectsTable.id,
          projectTitle: longFormProjectsTable.title,
          sceneNumber: longFormShotsTable.sceneNumber,
          shotNumber: longFormShotsTable.shotNumber,
        })
        .from(longFormShotsTable)
        .innerJoin(longFormProjectsTable, eq(longFormProjectsTable.id, longFormShotsTable.projectId))
        .where(inArray(longFormShotsTable.id, shotIds))
      : [],
  ]);
  const serverNames = new Map(servers.map((server) => [server.id, server.displayName]));
  const workflowNames = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  const contextsByShot = new Map(longFormContexts.map(({ shotId, ...context }) => [shotId, context]));
  return jobs.map((job) => presentGeneration(
    job,
    job.comfyServerId ? serverNames.get(job.comfyServerId) ?? null : null,
    job.workflowTemplateId ? workflowNames.get(job.workflowTemplateId) ?? null : null,
    job.longFormShotId ? contextsByShot.get(job.longFormShotId) ?? null : null,
  ));
}

router.get("/generations", async (req, res): Promise<void> => {
  const parsed = ListGenerationsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const page = Math.max(1, parsed.data.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, parsed.data.pageSize ?? 24));
  const [{ total }] = await db.select({ total: count() }).from(generationJobsTable);
  const totalItems = Number(total);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(page, totalPages);
  const jobs = await db.select()
    .from(generationJobsTable)
    .orderBy(desc(generationJobsTable.createdAt), desc(generationJobsTable.id))
    .limit(pageSize)
    .offset((safePage - 1) * pageSize);
  res.json(ListGenerationsResponse.parse({
    items: await presentMany(jobs),
    page: safePage,
    pageSize,
    totalItems,
    totalPages,
  }));
});

router.post("/generations", async (req, res): Promise<void> => {
  const input = CreateGenerationBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  try {
    const job = await createAndSubmitGeneration(input.data);
    res.status(201).json(CreateGenerationResponse.parse(await present(job)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation could not be submitted";
    const status = message.startsWith("No healthy") || message.startsWith("No active") ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

router.get("/generations/:id", async (req, res): Promise<void> => {
  const params = GetGenerationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  let [job] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Generation not found" });
    return;
  }
  if (job.status === "FAILED" && job.errorMessage === "Timed out while waiting for ComfyUI") {
    await recoverTimedOutGeneration(job.id);
    [job] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, params.data.id));
  }
  res.json(GetGenerationResponse.parse(await present(job)));
});

router.delete("/generations/:id", async (req, res): Promise<void> => {
  const params = GetGenerationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [job] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Generation not found" });
    return;
  }
  if (["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"].includes(job.status)) {
    res.status(409).json({ error: "Cancel the active generation before deleting it." });
    return;
  }

  const outputKey = job.outputStorageKey;
  const [deleted] = await db.transaction(async (tx) => {
    await tx.update(longFormShotsTable)
      .set({ generationJobId: null })
      .where(eq(longFormShotsTable.generationJobId, job.id));
    return tx.delete(generationJobsTable)
      .where(eq(generationJobsTable.id, job.id))
      .returning({ id: generationJobsTable.id });
  });
  if (!deleted) {
    res.status(404).json({ error: "Generation not found" });
    return;
  }

  if (outputKey) {
    const [stillReferenced] = await db.select({ id: longFormShotsTable.id })
      .from(longFormShotsTable)
      .where(eq(longFormShotsTable.outputStorageKey, outputKey));
    if (!stillReferenced) {
      await mediaStorage.deleteOutput(outputKey);
    }
  }
  res.sendStatus(204);
});

router.post("/generations/:id/cancel", async (req, res): Promise<void> => {
  const params = GetGenerationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const job = await cancelGeneration(params.data.id);
    res.json(GetGenerationResponse.parse(await present(job)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation could not be cancelled";
    const status = message === "Generation job not found" ? 404 : 409;
    res.status(status).json({ error: message });
  }
});

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const [characters, settings, servers, jobs] = await Promise.all([
    db.select().from(charactersTable),
    db.select().from(settingsTable),
    db.select().from(comfyServersTable),
    db.select().from(generationJobsTable).orderBy(desc(generationJobsTable.createdAt)),
  ]);
  const latestGenerations = await Promise.all(jobs.slice(0, 5).map(present));
  res.json(GetDashboardSummaryResponse.parse({
    characterCount: characters.length,
    settingCount: settings.length,
    onlineServerCount: servers.filter((server) => server.status === "ONLINE").length,
    activeGenerationCount: jobs.filter((job) => ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"].includes(job.status)).length,
    completedGenerationCount: jobs.filter((job) => job.status === "COMPLETED").length,
    latestGenerations,
  }));
});

export default router;
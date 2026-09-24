import { and, count, desc, eq, inArray } from "drizzle-orm";
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
  generationCharactersTable,
  generationSettingsTable,
  longFormProjectsTable,
  longFormShotsTable,
  settingsTable,
  workflowTemplatesTable,
} from "@workspace/db";
import { cancelGeneration, createAndSubmitGeneration, recoverTimedOutGeneration } from "../lib/generation-service";
import { presentGeneration } from "../lib/studio-presenters";
import { mediaStorage } from "../lib/storage-service";
import { ResourceNotFoundError } from "../lib/resource-errors";

const router: IRouter = Router();

function restoreContextFromMetadata(
  job: typeof generationJobsTable.$inferSelect,
  allowSharedReferenceVideo = false,
) {
  const raw = job.providerTaskMetadata.composerRequest;
  const composer = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const stringValue = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
  const numberValue = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const referenceVideoKey = stringValue(composer.referenceVideoKey, "");
  return {
    characterIds: Array.isArray(composer.characterIds)
      ? composer.characterIds.filter((id): id is string => typeof id === "string")
      : [],
    settingId: typeof composer.settingId === "string" ? composer.settingId : null,
    referenceVideoKey: referenceVideoKey.startsWith(`tenants/${job.tenantId}/`)
      || (allowSharedReferenceVideo && referenceVideoKey.startsWith("reference-videos/"))
      ? referenceVideoKey
      : null,
    cameraInstructions: stringValue(composer.cameraInstructions),
    motionInstructions: stringValue(composer.motionInstructions),
    requestedWidth: numberValue(composer.requestedWidth, job.width),
    requestedHeight: numberValue(composer.requestedHeight, job.height),
    requestedDurationSeconds: numberValue(composer.requestedDurationSeconds, job.durationSeconds),
  };
}

async function present(job: typeof generationJobsTable.$inferSelect, allowSharedReferenceVideo = false) {
  const [server, workflow, longFormContext, characterRows, settingRows] = await Promise.all([
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
        .where(and(
          eq(longFormShotsTable.id, job.longFormShotId),
          eq(longFormProjectsTable.tenantId, job.tenantId),
        ))
        .limit(1)
      : [],
    db.select({ characterId: generationCharactersTable.characterId })
      .from(generationCharactersTable)
      .where(eq(generationCharactersTable.generationJobId, job.id))
      .orderBy(generationCharactersTable.sortOrder),
    db.select({ settingId: generationSettingsTable.settingId })
      .from(generationSettingsTable)
      .where(eq(generationSettingsTable.generationJobId, job.id))
      .limit(1),
  ]);
  const metadata = restoreContextFromMetadata(job, allowSharedReferenceVideo);
  return presentGeneration(
    job,
    server[0]?.displayName ?? null,
    workflow[0]?.name ?? null,
    longFormContext[0] ?? null,
    {
      ...metadata,
      characterIds: characterRows.length ? characterRows.map(({ characterId }) => characterId) : metadata.characterIds,
      settingId: settingRows[0]?.settingId ?? metadata.settingId,
    },
  );
}

async function presentMany(
  jobs: Array<typeof generationJobsTable.$inferSelect>,
  allowSharedReferenceVideo = false,
) {
  const serverIds = [...new Set(jobs.map((job) => job.comfyServerId).filter((id): id is string => Boolean(id)))];
  const workflowIds = [...new Set(jobs.map((job) => job.workflowTemplateId).filter((id): id is string => Boolean(id)))];
  const shotIds = [...new Set(jobs.map((job) => job.longFormShotId).filter((id): id is string => Boolean(id)))];
  const [servers, workflows, longFormContexts, characterRows, settingRows] = await Promise.all([
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
        .where(and(
          inArray(longFormShotsTable.id, shotIds),
          eq(longFormProjectsTable.tenantId, jobs[0]?.tenantId ?? ""),
        ))
      : [],
    jobs.length
      ? db.select({
        generationJobId: generationCharactersTable.generationJobId,
        characterId: generationCharactersTable.characterId,
        sortOrder: generationCharactersTable.sortOrder,
      }).from(generationCharactersTable).where(inArray(
        generationCharactersTable.generationJobId,
        jobs.map((job) => job.id),
      )).orderBy(generationCharactersTable.sortOrder)
      : [],
    jobs.length
      ? db.select({
        generationJobId: generationSettingsTable.generationJobId,
        settingId: generationSettingsTable.settingId,
      }).from(generationSettingsTable).where(inArray(
        generationSettingsTable.generationJobId,
        jobs.map((job) => job.id),
      ))
      : [],
  ]);
  const serverNames = new Map(servers.map((server) => [server.id, server.displayName]));
  const workflowNames = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  const contextsByShot = new Map(longFormContexts.map(({ shotId, ...context }) => [shotId, context]));
  const charactersByJob = new Map<string, string[]>();
  for (const row of characterRows) {
    const ids = charactersByJob.get(row.generationJobId) ?? [];
    ids.push(row.characterId);
    charactersByJob.set(row.generationJobId, ids);
  }
  const settingByJob = new Map(settingRows.map((row) => [row.generationJobId, row.settingId]));
  return jobs.map((job) => presentGeneration(
    job,
    job.comfyServerId ? serverNames.get(job.comfyServerId) ?? null : null,
    job.workflowTemplateId ? workflowNames.get(job.workflowTemplateId) ?? null : null,
    job.longFormShotId ? contextsByShot.get(job.longFormShotId) ?? null : null,
    {
      ...restoreContextFromMetadata(job, allowSharedReferenceVideo),
      characterIds: charactersByJob.get(job.id) ?? restoreContextFromMetadata(job, allowSharedReferenceVideo).characterIds,
      settingId: settingByJob.get(job.id) ?? restoreContextFromMetadata(job, allowSharedReferenceVideo).settingId,
    },
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
  const [{ total }] = await db.select({ total: count() }).from(generationJobsTable)
    .where(eq(generationJobsTable.tenantId, req.context!.tenant!.id));
  const totalItems = Number(total);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(page, totalPages);
  const jobs = await db.select()
    .from(generationJobsTable)
    .where(eq(generationJobsTable.tenantId, req.context!.tenant!.id))
    .orderBy(desc(generationJobsTable.createdAt), desc(generationJobsTable.id))
    .limit(pageSize)
    .offset((safePage - 1) * pageSize);
  res.json(ListGenerationsResponse.parse({
    items: await presentMany(jobs, req.context!.tenant!.isDefault),
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
    const job = await createAndSubmitGeneration({
      ...input.data,
      tenantId: req.context!.tenant!.id,
      createdByUserId: req.context!.user.id,
    });
     res.status(201).json(CreateGenerationResponse.parse(await present(job, req.context!.tenant!.isDefault)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation could not be submitted";
    const status = error instanceof ResourceNotFoundError
      ? 404
      : message.startsWith("No healthy") || message.startsWith("No active") ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

router.get("/generations/:id", async (req, res): Promise<void> => {
  const params = GetGenerationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  let [job] = await db.select().from(generationJobsTable).where(and(
    eq(generationJobsTable.id, params.data.id),
    eq(generationJobsTable.tenantId, req.context!.tenant!.id),
  ));
  if (!job) {
    res.status(404).json({ error: "Generation not found" });
    return;
  }
  if (
    job.status === "FAILED" &&
    ["Timed out while waiting for ComfyUI", "Timed out while waiting for Cloud", "Timed out while waiting for fal.ai"].includes(job.errorMessage ?? "")
  ) {
    await recoverTimedOutGeneration(job.id);
    [job] = await db.select().from(generationJobsTable).where(and(
      eq(generationJobsTable.id, params.data.id),
      eq(generationJobsTable.tenantId, req.context!.tenant!.id),
    ));
  }
   res.json(GetGenerationResponse.parse(await present(job, req.context!.tenant!.isDefault)));
});

router.delete("/generations/:id", async (req, res): Promise<void> => {
  const params = GetGenerationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [job] = await db.select().from(generationJobsTable).where(and(
    eq(generationJobsTable.id, params.data.id),
    eq(generationJobsTable.tenantId, req.context!.tenant!.id),
  ));
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
    const [owned] = await db.select({ id: generationJobsTable.id }).from(generationJobsTable).where(and(
      eq(generationJobsTable.id, params.data.id),
      eq(generationJobsTable.tenantId, req.context!.tenant!.id),
    ));
    if (!owned) {
      res.status(404).json({ error: "Generation not found" });
      return;
    }
    const job = await cancelGeneration(params.data.id);
     res.json(GetGenerationResponse.parse(await present(job, req.context!.tenant!.isDefault)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation could not be cancelled";
    const status = message === "Generation job not found" ? 404 : 409;
    res.status(status).json({ error: message });
  }
});

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const tenantId = req.context!.tenant!.id;
  const [characters, settings, servers, jobs] = await Promise.all([
    db.select().from(charactersTable).where(eq(charactersTable.tenantId, tenantId)),
    db.select().from(settingsTable).where(eq(settingsTable.tenantId, tenantId)),
    db.select().from(comfyServersTable),
    db.select().from(generationJobsTable).where(eq(generationJobsTable.tenantId, tenantId)).orderBy(desc(generationJobsTable.createdAt)),
  ]);
   const latestGenerations = await Promise.all(jobs.slice(0, 5).map((job) => present(job, req.context!.tenant!.isDefault)));
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
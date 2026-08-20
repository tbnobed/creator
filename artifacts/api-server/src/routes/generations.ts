import { desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateGenerationBody,
  CreateGenerationResponse,
  GetDashboardSummaryResponse,
  GetGenerationParams,
  GetGenerationResponse,
  ListGenerationsResponse,
} from "@workspace/api-zod";
import {
  charactersTable,
  comfyServersTable,
  db,
  generationJobsTable,
  settingsTable,
  workflowTemplatesTable,
} from "@workspace/db";
import { createAndSubmitGeneration } from "../lib/generation-service";
import { presentGeneration } from "../lib/studio-presenters";

const router: IRouter = Router();

async function present(job: typeof generationJobsTable.$inferSelect) {
  const [server, workflow] = await Promise.all([
    job.comfyServerId ? db.select({ displayName: comfyServersTable.displayName }).from(comfyServersTable).where(eq(comfyServersTable.id, job.comfyServerId)) : [],
    job.workflowTemplateId ? db.select({ name: workflowTemplatesTable.name }).from(workflowTemplatesTable).where(eq(workflowTemplatesTable.id, job.workflowTemplateId)) : [],
  ]);
  return presentGeneration(job, server[0]?.displayName ?? null, workflow[0]?.name ?? null);
}

router.get("/generations", async (_req, res): Promise<void> => {
  const jobs = await db.select().from(generationJobsTable).orderBy(desc(generationJobsTable.createdAt));
  res.json(ListGenerationsResponse.parse(await Promise.all(jobs.map(present))));
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
  const [job] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Generation not found" });
    return;
  }
  res.json(GetGenerationResponse.parse(await present(job)));
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
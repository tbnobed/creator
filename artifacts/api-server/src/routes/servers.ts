import { eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateServerBody,
  CreateServerResponse,
  DeleteServerParams,
  GetServerQueueParams,
  GetServerQueueResponse,
  ListServersResponse,
  TestServerConnectionParams,
  TestServerConnectionResponse,
  UpdateServerBody,
  UpdateServerParams,
  UpdateServerResponse,
} from "@workspace/api-zod";
import { comfyServersTable, db, workflowTemplatesTable } from "@workspace/db";
import { assertTrustedComfyUrl, ComfyUIClient } from "../lib/comfy/client";
import { presentServer } from "../lib/studio-presenters";

const router: IRouter = Router();

async function present(server: typeof comfyServersTable.$inferSelect) {
  const workflows = await db.select().from(workflowTemplatesTable);
  const supported = workflows.filter((workflow) =>
    workflow.compatibleServerTags.every((tag) => server.tags.includes(tag)),
  ).length;
  return presentServer(server, supported);
}

router.get("/servers", async (_req, res): Promise<void> => {
  const servers = await db.select().from(comfyServersTable);
  res.json(ListServersResponse.parse(await Promise.all(servers.map(present))));
});

router.post("/servers", async (req, res): Promise<void> => {
  const input = CreateServerBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  try {
    const apiUrl = await assertTrustedComfyUrl(input.data.apiBaseUrl);
    const websocketUrl = new URL(input.data.websocketUrl);
    if (!["ws:", "wss:"].includes(websocketUrl.protocol) || websocketUrl.hostname !== apiUrl.hostname) {
      throw new Error("WebSocket URL must use ws/wss and match the configured API host");
    }
    const [server] = await db.insert(comfyServersTable).values({
      ...input.data,
      hostname: apiUrl.hostname,
      tags: input.data.tags ?? [],
      gpuName: input.data.gpuName ?? null,
      vramGb: input.data.vramGb ?? null,
      maxConcurrentJobs: input.data.maxConcurrentJobs ?? null,
      enabled: input.data.enabled ?? true,
    }).returning();
    res.status(201).json(CreateServerResponse.parse(await present(server)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid server configuration" });
  }
});

router.patch("/servers/:id", async (req, res): Promise<void> => {
  const params = UpdateServerParams.safeParse(req.params);
  const input = UpdateServerBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  try {
    const apiUrl = await assertTrustedComfyUrl(input.data.apiBaseUrl);
    const wsUrl = new URL(input.data.websocketUrl);
    if (!["ws:", "wss:"].includes(wsUrl.protocol) || wsUrl.hostname !== apiUrl.hostname) throw new Error("WebSocket URL must use ws/wss and match API host");
    const [server] = await db.update(comfyServersTable).set({
      ...input.data,
      hostname: apiUrl.hostname,
      tags: input.data.tags ?? [],
      gpuName: input.data.gpuName ?? null,
      vramGb: input.data.vramGb ?? null,
      maxConcurrentJobs: input.data.maxConcurrentJobs ?? null,
      enabled: input.data.enabled ?? true,
    }).where(eq(comfyServersTable.id, params.data.id)).returning();
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json(UpdateServerResponse.parse(await present(server)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid server configuration" });
  }
});

router.delete("/servers/:id", async (req, res): Promise<void> => {
  const params = DeleteServerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [server] = await db.delete(comfyServersTable).where(eq(comfyServersTable.id, params.data.id)).returning();
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/servers/:id/test", async (req, res): Promise<void> => {
  const params = TestServerConnectionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [server] = await db.select().from(comfyServersTable).where(eq(comfyServersTable.id, params.data.id));
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    const client = new ComfyUIClient(server);
    const [stats, queue] = await Promise.all([client.getSystemStats(), client.getQueue()]);
    const devices = Array.isArray(stats.devices) ? stats.devices : [];
    const device = devices[0] as { name?: string; total_memory?: number; free_memory?: number } | undefined;
    const gpuName = device?.name ?? server.gpuName;
    const vramGb = device?.total_memory ? Math.round((device.total_memory / 1024 ** 3) * 10) / 10 : server.vramGb;
    const memoryUsedGb = device?.total_memory && device.free_memory ? Math.round(((device.total_memory - device.free_memory) / 1024 ** 3) * 10) / 10 : null;
    await db.update(comfyServersTable).set({
      status: "ONLINE",
      gpuName,
      vramGb,
      memoryUsedGb,
      queueSize: queue.queue_pending?.length ?? 0,
      activeJobCount: queue.queue_running?.length ?? 0,
      lastHeartbeat: new Date(),
    }).where(eq(comfyServersTable.id, server.id));
    res.json(TestServerConnectionResponse.parse({ connected: true, message: "Connected to ComfyUI", server: server.hostname, gpu: gpuName, vramGb }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "ComfyUI connection failed";
    await db.update(comfyServersTable).set({ status: "OFFLINE" }).where(eq(comfyServersTable.id, server.id));
    res.json(TestServerConnectionResponse.parse({ connected: false, message, server: server.hostname, gpu: null, vramGb: null }));
  }
});

router.get("/servers/:id/queue", async (req, res): Promise<void> => {
  const params = GetServerQueueParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [server] = await db.select().from(comfyServersTable).where(eq(comfyServersTable.id, params.data.id));
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    const queue = await new ComfyUIClient(server).getQueue();
    res.json(GetServerQueueResponse.parse({
      queueRunning: queue.queue_running?.length ?? 0,
      queuePending: queue.queue_pending?.length ?? 0,
      queueRunningIds: [],
      queuePendingIds: [],
    }));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "ComfyUI unavailable" });
  }
});

export default router;
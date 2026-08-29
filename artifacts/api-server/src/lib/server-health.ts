import { eq } from "drizzle-orm";
import { db, comfyServersTable } from "@workspace/db";
import { ComfyUIClient } from "./comfy/client";
import { logger } from "./logger";

const HEALTH_CHECK_INTERVAL_MS = 60 * 1000;

async function pingServer(server: typeof comfyServersTable.$inferSelect): Promise<void> {
  const client = new ComfyUIClient(server);
  try {
    const [stats, queue] = await Promise.all([client.getSystemStats(), client.getQueue()]);
    const devices = Array.isArray(stats.devices) ? stats.devices : [];
    const device = devices[0] as { name?: string; total_memory?: number; free_memory?: number } | undefined;
    const gpuName = device?.name ?? server.gpuName;
    const vramGb = device?.total_memory ? Math.round((device.total_memory / 1024 ** 3) * 10) / 10 : server.vramGb;
    const memoryUsedGb =
      device?.total_memory && device.free_memory
        ? Math.round(((device.total_memory - device.free_memory) / 1024 ** 3) * 10) / 10
        : null;
    await db.update(comfyServersTable).set({
      status: "ONLINE",
      gpuName,
      vramGb,
      memoryUsedGb,
      queueSize: queue.queue_pending?.length ?? 0,
      activeJobCount: queue.queue_running?.length ?? 0,
      lastHeartbeat: new Date(),
    }).where(eq(comfyServersTable.id, server.id));
    logger.info({ server: server.displayName }, "Server health check: ONLINE");
  } catch (err) {
    await db.update(comfyServersTable).set({ status: "OFFLINE" })
      .where(eq(comfyServersTable.id, server.id));
    logger.warn({ server: server.displayName, err }, "Server health check: OFFLINE");
  }
}

async function checkAllServers(): Promise<void> {
  const servers = await db.select().from(comfyServersTable);
  await Promise.allSettled(servers.filter((s) => s.enabled).map(pingServer));
}

export async function startServerHealthChecks(): Promise<void> {
  // Run immediately on startup, then on a fixed interval.
  await checkAllServers();
  setInterval(() => void checkAllServers(), HEALTH_CHECK_INTERVAL_MS);
}

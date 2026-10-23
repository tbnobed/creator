import { db, pool, comfyServersTable, workflowTemplatesTable } from "../lib/db/src/index";
import { createRequire } from "node:module";
const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { eq } = require("drizzle-orm") as typeof import("../lib/db/node_modules/drizzle-orm");

// Explicit operator-requested endpoints. Does not revive retired worker rows,
// change GPU services, or assign the reserved H100 MIG slice.
const host = "98.191.147.191";
async function json(base: string, route: string) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${base}${route}: HTTP ${response.status}`);
  return response.json();
}
async function main() {
  const workflows = await db.select().from(workflowTemplatesTable);
  const existing = await db.select().from(comfyServersTable);
  for (const port of [8188, 8189, 8190, 8191, 8192]) {
    const base = `http://${host}:${port}`;
    const [stats, info, queue] = await Promise.all([
      json(base, "/system_stats"), json(base, "/object_info"), json(base, "/queue"),
    ]);
    const device = stats.devices?.find((d: { type: string }) => d.type === "cuda");
    if (!device) throw new Error(`No CUDA device at ${base}`);
    const hardware = port < 8191 ? "a100" : "blackwell";
    if (!(port < 8191 ? /H100.*MIG/ : /RTX 5090/).test(device.name)) {
      throw new Error(`Unexpected GPU at ${base}; refusing registration`);
    }
    const compatible: string[] = [];
    for (const workflow of workflows.filter(w => w.active && w.apiWorkflow && w.compatibleServerTags.includes(hardware))) {
      const errors: string[] = [];
      for (const [id, raw] of Object.entries(workflow.apiWorkflow!)) {
        const node = raw as { class_type: string; inputs: Record<string, unknown> };
        const metadata = info[node.class_type];
        if (!metadata) { errors.push(`${id}: missing ${node.class_type}`); continue; }
        for (const [key, rawSpec] of Object.entries(metadata.input?.required ?? {})) {
          const spec = rawSpec as unknown[];
          const value = node.inputs[key];
          const autogrow = spec[0] === "COMFY_AUTOGROW_V3"
            && Object.keys(node.inputs).some(k => k.startsWith(`${key}.`));
          if (value === undefined && !autogrow) errors.push(`${id}: missing ${key}`);
          if (Array.isArray(spec[0]) && value !== undefined && !Array.isArray(value)
            && node.class_type !== "LoadImage" && node.class_type !== "LoadVideo"
            && !spec[0].includes(value)) errors.push(`${id}: unsupported ${key}`);
        }
      }
      if (!errors.length) compatible.push(workflow.name);
    }
    const tags = [hardware];
    if (compatible.some(name => name.includes("MiniMax H3"))) tags.push("minimax-h3");
    const current = existing.find(w => !w.deletedAt && new URL(w.apiBaseUrl).origin === base);
    const values = {
      displayName: current?.displayName ?? (port < 8191 ? `H100 MIG ${port}` : `RTX 5090 ${port}`),
      hostname: host, apiBaseUrl: `${base}/`, websocketUrl: `ws://${host}:${port}/ws`,
      gpuName: device.name, vramGb: device.vram_total / 1024 ** 3,
      tags: [...new Set([...(current?.tags ?? []), ...tags])],
      enabled: true, maxConcurrentJobs: 1, status: "ONLINE",
      queueSize: queue.queue_pending.length, activeJobCount: queue.queue_running.length,
      memoryUsedGb: (device.vram_total - device.vram_free) / 1024 ** 3,
      lastHeartbeat: new Date(),
    };
    if (current) await db.update(comfyServersTable).set(values).where(eq(comfyServersTable.id, current.id));
    else await db.insert(comfyServersTable).values(values);
    console.log(JSON.stringify({ port, action: current ? "updated" : "added", tags, compatible, concurrency: 1 }));
  }
}
main().finally(() => pool.end()).catch(error => { console.error(error.message); process.exitCode = 1; });

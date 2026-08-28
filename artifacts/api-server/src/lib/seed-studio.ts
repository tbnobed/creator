import { count, eq } from "drizzle-orm";
import {
  charactersTable,
  comfyServersTable,
  db,
  pool,
  settingsTable,
  workflowTemplatesTable,
} from "@workspace/db";
import { assertTrustedComfyUrl } from "./comfy/client";
import {
  createMiniMaxH3R2vWorkflow,
  createMiniMaxH3R2vVideoWorkflow,
  miniMaxH3R2vSeed,
  miniMaxH3R2vVideoSeed,
  r2vMappings,
  r2vVideoMappings,
} from "./seed-data/minimax-h3-r2v";

let seeded = false;

type WorkerSeed = {
  displayName: string;
  apiBaseUrl: string;
  websocketUrl: string;
  hostname: string;
  tags: string[];
  enabled: boolean;
  priority: number;
  maxConcurrentJobs: number | null;
};

function readOptional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = readOptional(name);
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function readInteger(name: string, fallback: number | null): number | null {
  const value = readOptional(name);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

async function configuredWorker(
  prefix: "A100" | "BLACKWELL",
  defaults: { displayName: string; tags: string[]; priority: number },
): Promise<WorkerSeed | null> {
  const apiBaseUrl = readOptional(`OBTV_SEED_${prefix}_API_URL`);
  const websocketUrl = readOptional(`OBTV_SEED_${prefix}_WEBSOCKET_URL`);
  if (!apiBaseUrl && !websocketUrl) return null;
  if (!apiBaseUrl || !websocketUrl) {
    throw new Error(`Set both OBTV_SEED_${prefix}_API_URL and OBTV_SEED_${prefix}_WEBSOCKET_URL`);
  }

  let wsUrl: URL;
  try {
    wsUrl = new URL(websocketUrl);
  } catch {
    throw new Error(`OBTV_SEED_${prefix}_API_URL and OBTV_SEED_${prefix}_WEBSOCKET_URL must be valid URLs`);
  }
  const allowedHosts = (process.env.COMFY_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHosts.length === 0) {
    throw new Error("Set COMFY_ALLOWED_HOSTS before configuring an OBTV_SEED worker");
  }
  const apiUrl = await assertTrustedComfyUrl(apiBaseUrl);
  if (
    !["ws:", "wss:"].includes(wsUrl.protocol) ||
    wsUrl.username ||
    wsUrl.password ||
    apiUrl.hostname.toLowerCase() !== wsUrl.hostname.toLowerCase()
  ) {
    throw new Error(`OBTV_SEED_${prefix} worker URLs must use matching HTTP(S) and WS(S) hosts`);
  }

  return {
    displayName: readOptional(`OBTV_SEED_${prefix}_NAME`) ?? defaults.displayName,
    apiBaseUrl: apiUrl.toString(),
    websocketUrl: wsUrl.toString(),
    hostname: apiUrl.hostname,
    tags: defaults.tags,
    enabled: readBoolean(`OBTV_SEED_${prefix}_ENABLED`, true),
    priority: readInteger(`OBTV_SEED_${prefix}_PRIORITY`, defaults.priority) ?? defaults.priority,
    maxConcurrentJobs: readInteger(`OBTV_SEED_${prefix}_MAX_CONCURRENT_JOBS`, null),
  };
}

async function seedConfiguredWorkers(): Promise<void> {
  const workers = (await Promise.all([
    configuredWorker("A100", {
      displayName: "PN A100",
      tags: ["minimax-h3", "a100"],
      priority: 5,
    }),
    configuredWorker("BLACKWELL", {
      displayName: "GB10_Asus",
      tags: ["minimax-h3", "blackwell"],
      priority: 10,
    }),
  ])).filter((worker): worker is WorkerSeed => worker !== null);
  if (workers.length === 0) return;

  const existing = await db
    .select({
      id: comfyServersTable.id,
      displayName: comfyServersTable.displayName,
      tags: comfyServersTable.tags,
    })
    .from(comfyServersTable);
  const existingByName = new Map(existing.map((worker) => [worker.displayName, worker]));
  const missingWorkers = workers.filter((worker) => !existingByName.has(worker.displayName));
  if (missingWorkers.length > 0) {
    await db.insert(comfyServersTable).values(missingWorkers);
  }
  await Promise.all(workers.flatMap((worker) => {
    const current = existingByName.get(worker.displayName);
    if (!current) return [];
    const canonicalTags = new Set(worker.tags.map((tag) => tag.toLowerCase()));
    const mergedTags = [
      ...worker.tags,
      ...current.tags.filter((tag) => !canonicalTags.has(tag.toLowerCase())),
    ];
    if (mergedTags.join("\u0000") === current.tags.join("\u0000")) return [];
    return [
      db.update(comfyServersTable)
        .set({ tags: mergedTags })
        .where(eq(comfyServersTable.id, current.id)),
    ];
  }));
}

async function seedWorkflowDefinitions(): Promise<void> {
  const existing = await db.select().from(workflowTemplatesTable);
  const existingNames = new Set(existing.map((workflow) => workflow.name));
  const variants = [
    {
      ...miniMaxH3R2vSeed.a100,
      createWorkflow: createMiniMaxH3R2vWorkflow,
      mappings: r2vMappings,
    },
    {
      ...miniMaxH3R2vSeed.blackwell,
      createWorkflow: createMiniMaxH3R2vWorkflow,
      mappings: r2vMappings,
    },
    {
      ...miniMaxH3R2vVideoSeed.a100,
      createWorkflow: createMiniMaxH3R2vVideoWorkflow,
      mappings: r2vVideoMappings,
    },
    {
      ...miniMaxH3R2vVideoSeed.blackwell,
      createWorkflow: createMiniMaxH3R2vVideoWorkflow,
      mappings: r2vVideoMappings,
    },
  ];
  const blackwellVariant = miniMaxH3R2vSeed.blackwell;
  const videoVariants = variants.filter((variant) => variant.mappings === r2vVideoMappings);
  const legacyBlackwellPlaceholder = existing.find((workflow) => (
    workflow.name === blackwellVariant.name &&
    workflow.description === "Reference-character and image video generation. Import the actual ComfyUI API workflow before activation." &&
    workflow.generationMode === "REFERENCE_TO_VIDEO" &&
    workflow.modelFamily === "MiniMax H3" &&
    workflow.apiWorkflow === null &&
    workflow.active === false &&
    workflow.compatibleServerTags.length === 1 &&
    workflow.compatibleServerTags[0] === "minimax-h3" &&
    Object.keys(workflow.mappings).length === 0 &&
    workflow.expectedInputs.join(",") === "prompt,referenceImage1,width,height,frames,seed" &&
    workflow.expectedOutputs.join(",") === "video"
  ));
  if (legacyBlackwellPlaceholder) {
    await db.update(workflowTemplatesTable).set({
      description: blackwellVariant.description,
      generationMode: "r2v",
      modelFamily: "MiniMax H3",
      apiWorkflow: createMiniMaxH3R2vWorkflow(blackwellVariant.clipName),
      compatibleServerTags: [...blackwellVariant.tags],
      active: true,
      mappings: r2vMappings,
      expectedInputs: Object.keys(r2vMappings),
      expectedOutputs: ["video"],
    }).where(eq(workflowTemplatesTable.id, legacyBlackwellPlaceholder.id));
  }
  const missingVariants = variants
    .filter((variant) => !existingNames.has(variant.name))
    .map((variant) => ({
      name: variant.name,
      description: variant.description,
      generationMode: "r2v",
      modelFamily: "MiniMax H3",
      apiWorkflow: variant.createWorkflow(variant.clipName),
      compatibleServerTags: [...variant.tags],
      active: true,
      mappings: variant.mappings,
      expectedInputs: Object.keys(variant.mappings),
      expectedOutputs: ["video"],
    }));
  if (missingVariants.length > 0) {
    await db.insert(workflowTemplatesTable).values(missingVariants);
  }

  const staleVideoWorkflowRecords = existing.flatMap((workflow) => {
    const variant = videoVariants.find((candidate) => candidate.name === workflow.name);
    const apiWorkflow = workflow.apiWorkflow as Record<string, { class_type?: unknown; inputs?: Record<string, unknown> }> | null;
    const node136 = apiWorkflow?.["136"];
    const node130 = apiWorkflow?.["130"];
    const node137 = apiWorkflow?.["137"];
    const node139 = apiWorkflow?.["139"];
    const hasLegacyImageNodes = Boolean(
      variant &&
      node136?.inputs?.["ref_videos.ref_video_0"] &&
      node137?.class_type === "LoadImage" &&
      node137.inputs?.image === "reference-character-1.png" &&
      node139?.class_type === "LoadImage" &&
      node139.inputs?.image === "reference-character-2.png",
    );
    const audioLink = node130?.inputs?.audio;
    const usesGeneratedAudio = Array.isArray(audioLink) && audioLink[0] === "121";
    const isStaleVideoSeed = Boolean(variant && (hasLegacyImageNodes || usesGeneratedAudio));
    return isStaleVideoSeed && variant ? [{ workflow, variant }] : [];
  });
  await Promise.all(staleVideoWorkflowRecords.map(({ workflow, variant }) => (
    db.update(workflowTemplatesTable).set({
      description: variant.description,
      apiWorkflow: variant.createWorkflow(variant.clipName),
      mappings: variant.mappings,
      expectedInputs: Object.keys(variant.mappings),
      version: workflow.version + 1,
    }).where(eq(workflowTemplatesTable.id, workflow.id))
  )));

  if (!existingNames.has("MiniMax H3 FL2VA")) {
    await db.insert(workflowTemplatesTable).values({
      name: "MiniMax H3 FL2VA",
      description: "First and last frame video generation or clip continuation. Import the actual ComfyUI API workflow before activation.",
      generationMode: "FIRST_LAST_FRAME_TO_VIDEO",
      modelFamily: "MiniMax H3",
      compatibleServerTags: ["minimax-h3"],
      active: false,
      expectedInputs: ["prompt", "firstFrame", "lastFrame", "width", "height", "frames", "seed"],
      expectedOutputs: ["video"],
    });
  }
}

export async function ensureStudioSeed(): Promise<void> {
  if (seeded) return;
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(754229081)");
    const [{ total }] = await db.select({ total: count() }).from(charactersTable);
    if (total === 0) {
      await db.insert(charactersTable).values([
        {
          name: "Maya",
          description: "Female podcast host",
          promptDescription: "Maya is a woman in her early 30s with shoulder-length dark brown hair, warm brown eyes, olive skin and subtle natural makeup. She wears a cream-colored blouse.",
          tags: ["host", "wellness"],
          voiceProfile: "Warm conversational",
        },
        {
          name: "Daniel",
          description: "Holistic health expert",
          promptDescription: "Daniel is a man in his early 40s with short dark hair, a trimmed beard, and a charcoal shirt. He is calm, attentive and thoughtful.",
          tags: ["guest", "expert"],
        },
      ]);
    }
    const [{ settingTotal }] = await db.select({ settingTotal: count() }).from(settingsTable);
    if (settingTotal === 0) {
      await db.insert(settingsTable).values({
        name: "Wellness Podcast Studio",
        description: "A warm contemporary recording set",
        promptDescription: "An elegant contemporary wellness podcast studio with warm neutral tones, walnut acoustic panels, soft practical lighting, plants, black broadcast microphones and a shallow-depth-of-field cinematic background.",
        tags: ["podcast", "studio", "interior"],
      });
    }
    await seedWorkflowDefinitions();
    await seedConfiguredWorkers();
    seeded = true;
  } finally {
    await lock.query("SELECT pg_advisory_unlock(754229081)");
    lock.release();
  }
}
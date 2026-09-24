import { count, eq } from "drizzle-orm";
import {
  charactersTable,
  comfyServersTable,
  db,
  pool,
  settingsTable,
  tenantsTable,
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
import {
  createWan22I2vWorkflow,
  createWan22T2vWorkflow,
  wan22I2vMappings,
  wan22Seeds,
  wan22T2vMappings,
} from "./seed-data/wan-22";
import {
  createLtx25T2vWorkflow,
  ltx25T2vMappings,
  ltx25T2vSeed,
} from "./seed-data/ltx-25";

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

const hardwareTags = new Set(["a100", "blackwell"]);

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
      // Hardware is part of the seeded worker identity. Replace a stale
      // hardware tag instead of preserving it as a conflicting extra tag.
      ...current.tags.filter((tag) => {
        const normalizedTag = tag.toLowerCase();
        return !canonicalTags.has(normalizedTag) && !hardwareTags.has(normalizedTag);
      }),
    ];
    if (mergedTags.join("\u0000") === current.tags.join("\u0000")) return [];
    return [
      db.update(comfyServersTable)
        .set({ tags: mergedTags })
        .where(eq(comfyServersTable.id, current.id)),
    ];
  }));
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => equalJson(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && equalJson(leftRecord[key], rightRecord[key]));
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
      apiWorkflow: createMiniMaxH3R2vWorkflow(blackwellVariant.clipName, blackwellVariant.unetName),
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
      apiWorkflow: variant.createWorkflow(variant.clipName, variant.unetName),
      compatibleServerTags: [...variant.tags],
      active: true,
      mappings: variant.mappings,
      expectedInputs: Object.keys(variant.mappings),
      expectedOutputs: ["video"],
    }));
  if (missingVariants.length > 0) {
    await db.insert(workflowTemplatesTable).values(missingVariants);
  }

  // Older app-managed H3 image-reference seeds wrote a frame count directly
  // onto the model length, bypassing the graph's 24fps frame-grid expression.
  // Repair only that exact mapping on recognizable seeded geometry graphs.
  const legacyR2vMappings: Record<string, { nodeId: string; input: string }> = { ...r2vMappings };
  delete legacyR2vMappings.durationSeconds;
  legacyR2vMappings.frames = { nodeId: "136", input: "length" };
  const staleR2vMappings = existing.filter((workflow) => {
    const variant = variants.find((candidate) => candidate.name === workflow.name && candidate.mappings === r2vMappings);
    if (!variant || workflow.modelFamily !== "MiniMax H3" || workflow.generationMode !== "r2v"
      || !equalJson(workflow.mappings, legacyR2vMappings) || !workflow.apiWorkflow) return false;
    const graph = workflow.apiWorkflow as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
    const seedGraph = variant.createWorkflow(variant.clipName, variant.unetName);
    return graph["136"]?.class_type === "MiniMaxH3ReferenceToVideo"
      && graph["132"]?.class_type === "PrimitiveFloat"
      && graph["130"]?.class_type === "CreateVideo"
      && equalJson(graph["131"]?.inputs, seedGraph["131"].inputs)
      && equalJson(graph["136"]?.inputs?.length, seedGraph["136"].inputs.length);
  });
  await Promise.all(staleR2vMappings.map((workflow) => (
    db.update(workflowTemplatesTable).set({
      mappings: r2vMappings,
      expectedInputs: Object.keys(r2vMappings),
      version: workflow.version + 1,
    }).where(eq(workflowTemplatesTable.id, workflow.id))
  )));

  const externalVariants = [
    {
      ...wan22Seeds.t2v,
      modelFamily: "Wan 2.2 TI2V 5B",
      tags: wan22Seeds.tags,
      createWorkflow: createWan22T2vWorkflow,
      mappings: wan22T2vMappings,
    },
    {
      ...wan22Seeds.i2v,
      modelFamily: "Wan 2.2 TI2V 5B",
      tags: wan22Seeds.tags,
      createWorkflow: createWan22I2vWorkflow,
      mappings: wan22I2vMappings,
    },
    {
      ...ltx25T2vSeed,
      modelFamily: "LTX 2.5",
      createWorkflow: createLtx25T2vWorkflow,
      mappings: ltx25T2vMappings,
    },
  ];
  const missingExternalVariants = externalVariants
    .filter((variant) => !existingNames.has(variant.name))
    .map((variant) => ({
      name: variant.name,
      description: variant.description,
      generationMode: variant.generationMode,
      modelFamily: variant.modelFamily,
      apiWorkflow: variant.createWorkflow(),
      compatibleServerTags: [...variant.tags],
      active: false,
      mappings: variant.mappings,
      expectedInputs: Object.keys(variant.mappings),
      expectedOutputs: ["video"],
    }));
  if (missingExternalVariants.length > 0) {
    await db.insert(workflowTemplatesTable).values(missingExternalVariants);
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
      apiWorkflow: variant.createWorkflow(variant.clipName, variant.unetName),
      mappings: variant.mappings,
      expectedInputs: Object.keys(variant.mappings),
      version: workflow.version + 1,
    }).where(eq(workflowTemplatesTable.id, workflow.id))
  )));

  const upgradedVideoWorkflowIds = new Set(staleVideoWorkflowRecords.map(({ workflow }) => workflow.id));
  // Upgrade only the exact app-managed graph emitted by the previous seed.
  // A creator-imported/customized workflow is intentionally left untouched.
  const staleH3ModelPairRecords = existing.flatMap((workflow) => {
    if (upgradedVideoWorkflowIds.has(workflow.id)) return [];
    const variant = variants.find((candidate) => candidate.name === workflow.name);
    if (!variant || !workflow.apiWorkflow) return [];
    const previousSeed = variant.createWorkflow(variant.clipName);
    const expectedSeed = variant.createWorkflow(variant.clipName, variant.unetName);
    const isWrongSeedPair = !equalJson(previousSeed, expectedSeed)
      && equalJson(workflow.apiWorkflow, previousSeed);
    return isWrongSeedPair ? [{ workflow, variant }] : [];
  });
  await Promise.all(staleH3ModelPairRecords.map(({ workflow, variant }) => (
    db.update(workflowTemplatesTable).set({
      description: variant.description,
      apiWorkflow: variant.createWorkflow(variant.clipName, variant.unetName),
      compatibleServerTags: [...variant.tags],
      mappings: variant.mappings,
      expectedInputs: Object.keys(variant.mappings),
      version: workflow.version + 1,
    }).where(eq(workflowTemplatesTable.id, workflow.id))
  )));

  const upgradedH3ModelPairIds = new Set(staleH3ModelPairRecords.map(({ workflow }) => workflow.id));
  // Some persisted Blackwell image-reference graphs had their CLIP corrected
  // but retained the A100 UNet. Keep any unrelated graph edits intact.
  const mixedBlackwellH3Records = existing.filter((workflow) => {
    if (upgradedH3ModelPairIds.has(workflow.id)
      || upgradedVideoWorkflowIds.has(workflow.id)
      || workflow.name !== blackwellVariant.name
      || workflow.modelFamily !== "MiniMax H3"
      || workflow.generationMode !== "r2v"
      || !equalJson(workflow.compatibleServerTags, [...blackwellVariant.tags])
      || !workflow.apiWorkflow) return false;
    const graph = workflow.apiWorkflow as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
    return graph["127"]?.class_type === "UNETLoader"
      && graph["127"].inputs?.unet_name === miniMaxH3R2vSeed.a100.unetName
      && graph["128"]?.class_type === "CLIPLoader"
      && graph["128"].inputs?.clip_name === blackwellVariant.clipName
      && graph["136"]?.class_type === "MiniMaxH3ReferenceToVideo";
  });
  await Promise.all(mixedBlackwellH3Records.map((workflow) => {
    const repairedGraph = structuredClone(workflow.apiWorkflow) as Record<string, { inputs: Record<string, unknown> }>;
    repairedGraph["127"].inputs.unet_name = blackwellVariant.unetName;
    return db.update(workflowTemplatesTable).set({
      apiWorkflow: repairedGraph,
      version: workflow.version + 1,
    }).where(eq(workflowTemplatesTable.id, workflow.id));
  }));

  const staleTurboWorkflowRecords = existing.filter((workflow) => {
    if (upgradedVideoWorkflowIds.has(workflow.id) || upgradedH3ModelPairIds.has(workflow.id)) return false;
    const apiWorkflow = workflow.apiWorkflow as Record<string, { class_type?: unknown; inputs?: Record<string, unknown> }> | null;
    const node124 = apiWorkflow?.["124"];
    const node126 = apiWorkflow?.["126"];
    const node141 = apiWorkflow?.["141"];
    const node142 = apiWorkflow?.["142"];
    const node145 = apiWorkflow?.["145"];
    const node146 = apiWorkflow?.["146"];
    return Boolean(
      node124?.class_type === "BasicScheduler" &&
      Array.isArray(node124.inputs?.steps) &&
      node124.inputs.steps[0] === "142" &&
      node126?.class_type === "BasicGuider" &&
      Array.isArray(node126.inputs?.model) &&
      node126.inputs.model[0] === "141" &&
      node141?.class_type === "ComfySwitchNode" &&
      node142?.class_type === "ComfySwitchNode" &&
      node145?.class_type === "LoraLoaderModelOnly" &&
      node145.inputs?.lora_name === "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors" &&
      node146?.class_type === "PrimitiveBoolean" &&
      node146.inputs?.value === false
    );
  });
  await Promise.all(staleTurboWorkflowRecords.map((workflow) => {
    const apiWorkflow = structuredClone(workflow.apiWorkflow) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    apiWorkflow["124"].inputs.steps = 20;
    apiWorkflow["126"].inputs.model = ["127", 0];
    for (const nodeId of ["141", "142", "143", "144", "145", "146"]) {
      delete apiWorkflow[nodeId];
    }
    return db.update(workflowTemplatesTable).set({
      apiWorkflow,
      version: workflow.version + 1,
    }).where(eq(workflowTemplatesTable.id, workflow.id));
  }));

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
    const [defaultTenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.isDefault, true)).limit(1);
    const contentOwnerId = defaultTenant?.createdByUserId ?? "__obtv_legacy__";
    const [{ total }] = await db.select({ total: count() }).from(charactersTable);
    if (total === 0 && defaultTenant) {
      await db.insert(charactersTable).values([
        {
          tenantId: defaultTenant.id,
          createdByUserId: contentOwnerId,
          name: "Maya",
          description: "Female podcast host",
          promptDescription: "Maya is a woman in her early 30s with shoulder-length dark brown hair, warm brown eyes, olive skin and subtle natural makeup. She wears a cream-colored blouse.",
          tags: ["host", "wellness"],
          voiceProfile: "Warm conversational",
        },
        {
          tenantId: defaultTenant.id,
          createdByUserId: contentOwnerId,
          name: "Daniel",
          description: "Holistic health expert",
          promptDescription: "Daniel is a man in his early 40s with short dark hair, a trimmed beard, and a charcoal shirt. He is calm, attentive and thoughtful.",
          tags: ["guest", "expert"],
        },
      ]);
    }
    const [{ settingTotal }] = await db.select({ settingTotal: count() }).from(settingsTable);
    if (settingTotal === 0 && defaultTenant) {
      await db.insert(settingsTable).values({
        tenantId: defaultTenant.id,
        createdByUserId: contentOwnerId,
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
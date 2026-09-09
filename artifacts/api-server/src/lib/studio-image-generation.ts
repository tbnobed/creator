import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  characterAssetsTable,
  charactersTable,
  comfyServersTable,
  db,
  settingAssetsTable,
  settingsTable,
} from "@workspace/db";
import { ComfyUIClient } from "./comfy/client";
import { selectServer } from "./comfy/scheduler";
import { createFlux2KleinWorkflow, type Flux2AssetKind } from "./seed-data/flux2-klein";
import { mediaStorage } from "./storage-service";

const REQUIRED_TAGS = ["flux2-klein"];
const GENERATION_TIMEOUT_MS = 5 * 60_000;
const reservedServers = new Set<string>();

type ImageOutput = {
  filename: string;
  subfolder: string;
  type: string;
};

export class StudioImageGenerationUnavailableError extends Error {}

function buildPrompt(
  kind: Flux2AssetKind,
  entity: { name: string; description: string; promptDescription: string },
  requestedPrompt?: string,
): string {
  const subject = requestedPrompt?.trim() || entity.promptDescription.trim() || entity.description.trim();
  if (!subject) throw new Error("Add an image prompt before generating.");
  if (kind === "character") {
    return [
      "Production character reference image for film and video continuity.",
      `Character: ${entity.name}.`,
      subject,
      entity.description.trim(),
      "One character only, full body visible, neutral standing pose, looking toward camera, clean uncluttered studio background, realistic anatomy, natural skin and fabric detail, cinematic soft lighting, sharp focus, no typography, no watermark.",
    ].filter(Boolean).join(" ");
  }
  return [
    "Production environment reference image for film and video continuity.",
    `Location: ${entity.name}.`,
    subject,
    entity.description.trim(),
    "Wide establishing composition, environment only, no people, coherent architecture and geography, cinematic natural lighting, photoreal materials, deep detail, sharp focus, no typography, no watermark.",
  ].filter(Boolean).join(" ");
}

function chooseImageOutput(history: Record<string, unknown>, promptId: string): ImageOutput | null {
  const prompt = history[promptId] ?? Object.values(history)[0];
  if (!prompt || typeof prompt !== "object") return null;
  const outputs = (prompt as { outputs?: Record<string, Record<string, unknown>> }).outputs;
  if (!outputs) return null;
  for (const output of Object.values(outputs)) {
    if (!Array.isArray(output.images)) continue;
    for (const file of output.images as Array<Record<string, unknown>>) {
      if (typeof file.filename === "string" && /\.(png|jpe?g|webp)$/i.test(file.filename)) {
        return {
          filename: file.filename,
          subfolder: typeof file.subfolder === "string" ? file.subfolder : "",
          type: typeof file.type === "string" ? file.type : "output",
        };
      }
    }
  }
  return null;
}

function historyError(history: Record<string, unknown>, promptId: string): string | null {
  const prompt = history[promptId] ?? Object.values(history)[0];
  if (!prompt || typeof prompt !== "object") return null;
  const status = (prompt as { status?: { status_str?: unknown; messages?: unknown } }).status;
  if (status?.status_str !== "error") return null;
  return `ComfyUI image generation failed${status.messages ? `: ${JSON.stringify(status.messages).slice(0, 800)}` : ""}`;
}

async function waitForImage(client: ComfyUIClient, promptId: string): Promise<ImageOutput> {
  const timeoutAt = Date.now() + GENERATION_TIMEOUT_MS;
  while (Date.now() < timeoutAt) {
    const history = await client.getHistory(promptId);
    const error = historyError(history, promptId);
    if (error) throw new Error(error);
    const output = chooseImageOutput(history, promptId);
    if (output) return output;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Image generation timed out after 5 minutes.");
}

function imageMimeType(filename: string): "image/jpeg" | "image/png" | "image/webp" {
  if (/\.webp$/i.test(filename)) return "image/webp";
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  return "image/png";
}

export async function generateStudioImage(input: {
  kind: Flux2AssetKind;
  entityId: string;
  prompt?: string;
  seed?: number;
}): Promise<{ ok: true; assetId: string; mediaUrl: string; serverName: string; seed: number }> {
  const [entity] = input.kind === "character"
    ? await db.select().from(charactersTable).where(eq(charactersTable.id, input.entityId))
    : await db.select().from(settingsTable).where(eq(settingsTable.id, input.entityId));
  if (!entity) throw new Error(`${input.kind === "character" ? "Character" : "Setting"} not found`);

  const servers = (await db.select().from(comfyServersTable))
    .filter((server) => !reservedServers.has(server.id));
  const server = selectServer(servers, REQUIRED_TAGS);
  if (!server) {
    throw new StudioImageGenerationUnavailableError(
      "No FLUX.2 Klein worker is currently available. Check GPU status or wait for the active render to finish.",
    );
  }

  reservedServers.add(server.id);
  try {
    const seed = input.seed === undefined
      ? Math.floor(Math.random() * 2_147_483_647)
      : Math.floor(input.seed);
    const prompt = buildPrompt(input.kind, entity, input.prompt);
    const client = new ComfyUIClient(server);
    const workflow = createFlux2KleinWorkflow({ kind: input.kind, prompt, seed });
    const promptId = randomUUID();
    const submitted = await client.submitWorkflow(workflow, promptId);
    const output = await waitForImage(client, submitted.prompt_id);
    const bytes = await client.getOutputFile(output.filename, output.subfolder, output.type);
    const mimeType = imageMimeType(output.filename);
    const storageKey = await mediaStorage.storeImage(output.filename, mimeType, bytes, input.kind === "character" ? "characters" : "settings");
    const mediaUrl = `/api/media/${storageKey}`;

    if (input.kind === "character") {
      const [asset] = await db.insert(characterAssetsTable).values({
        characterId: entity.id,
        storageKey,
        originalName: output.filename.slice(0, 255),
        mimeType,
        angle: "AI generated reference",
        description: prompt.slice(0, 500),
      }).returning();
      if (!entity.thumbnail) {
        await db.update(charactersTable).set({ thumbnail: mediaUrl }).where(eq(charactersTable.id, entity.id));
      }
      return { ok: true, assetId: asset.id, mediaUrl, serverName: server.displayName, seed };
    }

    const [asset] = await db.insert(settingAssetsTable).values({
      settingId: entity.id,
      storageKey,
      originalName: output.filename.slice(0, 255),
      mimeType,
      description: prompt.slice(0, 500),
    }).returning();
    if (!entity.thumbnail) {
      await db.update(settingsTable).set({ thumbnail: mediaUrl }).where(eq(settingsTable.id, entity.id));
    }
    return { ok: true, assetId: asset.id, mediaUrl, serverName: server.displayName, seed };
  } finally {
    reservedServers.delete(server.id);
  }
}
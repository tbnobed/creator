import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, productionProjectsTable, type ProductionProjectRow } from "@workspace/db";
import { emptyProduction, numberIn, text, validateScenes, type ProductionState } from "./production-types";

export class ProductionConflict extends Error {}
export function stateOf(row: ProductionProjectRow): ProductionState { return row.state as unknown as ProductionState; }
export function presentProduction(row: ProductionProjectRow) {
  return { id: row.id, title: row.title, revision: row.revision, state: row.state, renderProjectId: row.renderProjectId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export async function ownedProduction(id: string, tenantId: string) {
  const [row] = await db.select().from(productionProjectsTable).where(and(eq(productionProjectsTable.id, id), eq(productionProjectsTable.tenantId, tenantId)));
  return row;
}
export async function productionLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [`production:${id}`]);
    if (!lock.rows[0]?.locked) throw new ProductionConflict("This project is being updated. Please retry in a moment.");
    try { return await work(); }
    finally { await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`production:${id}`]); }
  } finally { client.release(); }
}
export async function saveProduction(row: ProductionProjectRow, state: ProductionState, extra: { title?: string; renderProjectId?: string } = {}) {
  const [saved] = await db.update(productionProjectsTable).set({
    ...extra,
    // Cancellation is an out-of-band control message: preserve it atomically
    // even when the inference worker saves an older in-memory snapshot.
    state: sql`(${JSON.stringify(state)}::jsonb - 'storyCancelTaskId') || jsonb_build_object('storyCancelTaskId', coalesce(${productionProjectsTable.state}->'storyCancelTaskId', 'null'::jsonb))`,
    revision: sql`${productionProjectsTable.revision} + 1`, updatedAt: new Date(),
  }).where(and(eq(productionProjectsTable.id, row.id), eq(productionProjectsTable.revision, row.revision))).returning();
  if (!saved) throw new ProductionConflict("This project changed in another tab. Reload it before saving.");
  return saved;
}
export function applyProductionPatch(state: ProductionState, patch: Record<string, unknown>): ProductionState {
  const next = structuredClone(state);
  if (patch.step !== undefined) next.step = numberIn(patch.step, "Step", 0, 5);
  if (patch.story && typeof patch.story === "object") {
    const story = patch.story as Record<string, unknown>;
    const busy = state.tasks.some(t => t.type === "story" && ["QUEUED", "RUNNING"].includes(t.status));
    if (busy && ["summary", "script", "targetMinutes", "sourceMode"].some(key => story[key] !== undefined && story[key] !== (state.story as unknown as Record<string, unknown>)[key])) throw new ProductionConflict("Cancel writing before changing its source or duration.");
    if (story.summary !== undefined) next.story.summary = text(story.summary, "Summary", 20000, false);
    if (story.script !== undefined) next.story.script = text(story.script, "Script", 100000, false);
    if (story.targetMinutes !== undefined) {
      next.story.targetMinutes = numberIn(story.targetMinutes, "Duration in minutes", 1, 90);
    }
    if (story.sourceMode !== undefined) {
      if (!["summary", "script"].includes(String(story.sourceMode))) throw new Error("Choose Summary or Script.");
      next.story.sourceMode = story.sourceMode as "summary" | "script";
    }
    if (Array.isArray(story.scenes) && story.scenes.length && !busy) {
      const scenes = validateScenes(story.scenes);
      // Keep drafted shot plans only if the producer has not changed that scene.
      next.story.scenes = scenes.map((scene, i) => {
        const prior = state.story.scenes[i];
        return prior && prior.action === scene.action && prior.dialogue === scene.dialogue ? { ...scene, shots: prior.shots } : scene;
      });
    }
  }
  if (patch.settings && typeof patch.settings === "object") {
    const settings = patch.settings as Record<string, unknown>;
    if (settings.storyModel !== undefined) next.settings.storyModel = text(settings.storyModel, "Story model", 100);
    if (settings.videoModel !== undefined) next.settings.videoModel = text(settings.videoModel, "Video model", 100, false);
    if (settings.videoProvider !== undefined) {
      if (!["COMFYUI", "FAL"].includes(String(settings.videoProvider))) throw new Error("Unsupported video provider.");
      next.settings.videoProvider = settings.videoProvider as "COMFYUI" | "FAL";
    }
    // Spending permission can only be granted by the explicit create action.
    if (next.settings.videoProvider !== state.settings.videoProvider || next.settings.videoModel !== state.settings.videoModel) delete next.settings.videoConfirmed;
    if (settings.imageModels && typeof settings.imageModels === "object") {
      next.settings.imageModels = { ...next.settings.imageModels, ...Object.fromEntries(
        Object.entries(settings.imageModels).filter(([key]) => ["characters", "referenceSheet", "wardrobe", "places", "variants"].includes(key))
          .map(([key, value]) => [key, text(value, "Image model", 100)]),
      ) };
    }
    if (settings.generationMode !== undefined) next.settings.generationMode = text(settings.generationMode, "Workflow", 100, false);
    for (const key of ["width", "height"] as const) if (settings[key] !== undefined) next.settings[key] = numberIn(settings[key], key, 64, 4096);
    if (settings.shotDurationSeconds !== undefined) next.settings.shotDurationSeconds = numberIn(settings.shotDurationSeconds, "Shot duration", 2, 30);
    if (settings.fps !== undefined) {
      if (![24, 25, 30].includes(Number(settings.fps))) throw new Error("Unsupported frame rate.");
      next.settings.fps = Number(settings.fps) as 24 | 25 | 30;
    }
    if (settings.qualityPreset !== undefined) {
      if (!["DRAFT", "STANDARD", "HIGH"].includes(String(settings.qualityPreset))) throw new Error("Unsupported quality preset.");
      next.settings.qualityPreset = settings.qualityPreset as "DRAFT" | "STANDARD" | "HIGH";
    }
  }
  return next;
}
export async function createProduction(tenantId: string, userId: string, title: unknown, patch: Record<string, unknown>) {
  const state = applyProductionPatch(emptyProduction(), patch);
  const [row] = await db.insert(productionProjectsTable).values({
    id: randomUUID(), tenantId, createdByUserId: userId, title: text(title, "Title", 180), state: state as unknown as Record<string, unknown>,
  }).returning();
  return row;
}

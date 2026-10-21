import { eq } from "drizzle-orm";
import { db, productionProjectsTable } from "@workspace/db";
import { logger } from "./logger";
import { advanceProductionImage } from "./production-assets";
import { expandScene, outlineStory } from "./production-story";
import { productionLock, saveProduction, stateOf, ProductionConflict } from "./production-store";

let ticking = false;
export async function tickProductions() {
  if (ticking) return;
  ticking = true;
  try {
    const projects = await db.select().from(productionProjectsTable);
    for (const candidate of projects) {
      if (!stateOf(candidate).tasks?.some(t => ["QUEUED", "RUNNING"].includes(t.status))) continue;
      try {
        await productionLock(candidate.id, async () => {
          let [row] = await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.id, candidate.id));
          if (!row) return;
          const state = stateOf(row);
          const task = state.tasks.find(t => ["QUEUED", "RUNNING"].includes(t.status));
          if (!task) return;
          try {
            if (task.type === "story") {
              if (state.story.progress?.active) throw new Error("The previous writing request was interrupted. Your input is saved. Retry explicitly; no replacement request was submitted.");
              state.story.draftStatus = "RUNNING"; task.status = "RUNNING";
              const paid = task.storyModel && task.storyModel !== "local";
              state.story.progress = {
                stage: task.index === 0 ? "Preparing the scene list" : `Writing scene ${task.index} of ${state.story.scenes.length}`,
                model: paid ? task.storyModel!.replace(/^openai:/, "") : process.env.STORY_AI_MODEL?.trim() || "qwen2.5:1.5b",
                target: paid ? "Paid provider" : "GB10 / Blackwell",
                startedAt: new Date().toISOString(), active: true, gpuVerified: false,
              };
              // Publish progress before awaiting inference, not only when the
              // entire request ends. Keep the revision current for the final save.
              row = await saveProduction(row, state);
              const onGpuVerified = async () => {
                state.story.progress!.gpuVerified = true;
                row = await saveProduction(row, state);
              };
              if (task.index === 0) {
                state.story.scenes = await outlineStory({ title: row.title, ...state.story }, task.storyModel, onGpuVerified);
                task.index = 1;
              } else {
                const i = task.index - 1;
                if (i < state.story.scenes.length) {
                  state.story.scenes[i] = await expandScene(state.story.scenes[i], {
                    title: row.title, summary: state.story.summary, previousScene: state.story.scenes[i - 1],
                    targetSeconds: Math.ceil(state.story.targetMinutes * 60 / state.story.scenes.length),
                    shotSeconds: state.settings.shotDurationSeconds,
                  }, task.storyModel, onGpuVerified);
                  task.index++;
                }
                if (task.index > state.story.scenes.length) {
                  state.story.draftStatus = "READY"; task.status = "COMPLETED";
                }
              }
              state.story.progress.active = false;
            } else {
              await advanceProductionImage(row, state, task);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "Production task failed.";
            // Busy workers are capacity constraints, not failed creative drafts.
            if (/No .*worker.*available|safe render capacity|worker.*busy/i.test(message)) {
              task.status = "QUEUED"; task.error = "Waiting for an available local image worker.";
            } else {
              task.status = "FAILED"; task.error = message;
              if (task.type === "story") {
                state.story.draftStatus = "FAILED"; state.story.error = message;
                if (state.story.progress) { state.story.progress.active = false; state.story.progress.stage = "Writing stopped"; }
              }
              const entity = state.characters.find(c => c.id === task.entityId)
                ?? state.wardrobes.find(w => w.id === task.entityId)
                ?? state.places.flatMap(p => [p, ...p.variants]).find(p => p.id === task.entityId);
              if (entity) { entity.status = task.type === "sheet" ? "LOCKED" : "FAILED"; entity.error = message; }
              logger.warn({ productionId: row.id, taskType: task.type }, "Production task failed");
            }
          }
          await saveProduction(row, state);
        });
      } catch (error) {
        if (!(error instanceof ProductionConflict)) logger.warn({ productionId: candidate.id, errorType: error instanceof Error ? error.name : "unknown" }, "Production task tick failed");
      }
    }
  } finally { ticking = false; }
}
export function startProductionRuntime() {
  const timer = setInterval(() => { void tickProductions().catch(error => logger.warn({ errorType: error?.name }, "Production queue unavailable")); }, 3000);
  timer.unref();
}

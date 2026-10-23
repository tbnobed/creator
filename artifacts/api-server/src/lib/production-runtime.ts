import { eq } from "drizzle-orm";
import { db, productionProjectsTable } from "@workspace/db";
import { logger } from "./logger";
import { advanceProductionImage } from "./production-assets";
import { expandScene, outlineStory } from "./production-story";
import { productionLock, saveProduction, stateOf, ProductionConflict } from "./production-store";
import { registerStoryWriter, StoryCancelled } from "./production-story-control";
import { sceneWritingSeconds, scriptSource } from "./production-script-plan";

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
          const queuedCancellation = state.tasks.find(t => t.type === "story" && t.id === state.storyCancelTaskId && t.status === "QUEUED");
          if (queuedCancellation) {
            queuedCancellation.status = "CANCELLED"; queuedCancellation.error = undefined;
            state.story.draftStatus = "CANCELLED"; state.story.error = undefined;
            if (state.story.progress) { state.story.progress.active = false; state.story.progress.stage = "Writing cancelled"; }
          }
          const task = state.tasks.find(t => ["QUEUED", "RUNNING"].includes(t.status));
          if (!task) { if (queuedCancellation) await saveProduction(row, state); return; }
          let cancellation: AbortController | undefined;
          let cancelTimer: ReturnType<typeof setInterval> | undefined;
          let unregister: (() => void) | undefined;
          try {
            if (task.type === "story") {
              cancellation = new AbortController();
              unregister = registerStoryWriter(row.id, cancellation);
              let checkingCancellation = false;
              const checkCancellation = async () => {
                if (checkingCancellation) return;
                checkingCancellation = true;
                try {
                  const [latest] = await db.select({ state: productionProjectsTable.state }).from(productionProjectsTable).where(eq(productionProjectsTable.id, row.id));
                  if (latest?.state?.storyCancelTaskId === task.id) cancellation!.abort(new StoryCancelled());
                } finally { checkingCancellation = false; }
              };
              await checkCancellation();
              cancellation.signal.throwIfAborted();
              cancelTimer = setInterval(() => { void checkCancellation().catch(() => cancellation!.abort(new Error("Cannot verify cancellation state; writing stopped safely."))); }, 1000);
              cancelTimer.unref();
              if (state.story.progress?.active) throw new Error("The previous writing request was interrupted. Your input is saved. Retry explicitly; no replacement request was submitted.");
              state.story.draftStatus = "RUNNING"; task.status = "RUNNING";
              const paid = task.storyModel && task.storyModel !== "local";
              state.story.progress = {
                stage: task.index === 0 ? "Preparing the scene list" : `Writing scene ${task.index} of ${state.story.scenes.length}`,
                model: paid ? task.storyModel!.replace(/^openai:/, "") : process.env.STORY_AI_MODEL?.trim() || "qwen3.8:27b-q8_0",
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
                state.story.scenes = await outlineStory({ title: row.title, ...state.story }, task.storyModel, onGpuVerified, cancellation.signal);
                // A new screenplay can reorder scene numbers. Do not carry a
                // prior scene's explicit set assignment into a different scene.
                state.settings.sceneReferences = {};
                task.index = 1;
              } else {
                const i = task.index - 1;
                if (i < state.story.scenes.length) {
                  state.story.scenes[i] = await expandScene(state.story.scenes[i], {
                    title: row.title, summary: state.story.summary, previousScene: state.story.scenes[i - 1],
                    targetSeconds: sceneWritingSeconds(state.story.scenes[i], state.story, state.story.scenes.length),
                    shotSeconds: state.settings.shotDurationSeconds,
                    preserveScript: !!scriptSource(state.story),
                  }, task.storyModel, onGpuVerified, cancellation.signal);
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
            if (error instanceof StoryCancelled || cancellation?.signal.reason instanceof StoryCancelled) {
              task.status = "CANCELLED"; task.error = undefined;
              state.story.draftStatus = "CANCELLED"; state.story.error = undefined;
              if (state.story.progress) { state.story.progress.active = false; state.story.progress.stage = "Writing cancelled"; }
            } else if (/No .*worker.*available|safe render capacity|worker.*busy/i.test(message)) {
              task.status = "QUEUED"; task.error = task.type === "story" ? message : "Waiting for an available local image worker.";
              if (task.type === "story" && state.story.progress) {
                state.story.progress.active = false; state.story.progress.gpuVerified = false; state.story.progress.stage = "Waiting for GB10 GPU capacity";
              }
            } else {
              task.status = "FAILED"; task.error = message;
              if(task.type==="opening") {
                const scene=state.story.scenes.find(s=>String(s.sceneNumber)===task.entityId);
                if(scene?.opening)scene.opening.status="FAILED";
              }
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
          } finally {
            if (cancelTimer) clearInterval(cancelTimer);
            unregister?.();
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

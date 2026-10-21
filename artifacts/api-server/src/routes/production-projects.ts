import express, { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db, productionProjectsTable, longFormShotsTable, longFormProjectsTable } from "@workspace/db";
import { CreateProductionProjectBody, UpdateProductionProjectBody, RunProductionActionBody } from "@workspace/api-zod";
import { addTask, mutateProductionAsset } from "../lib/production-assets";
import { applyProductionPatch, createProduction, ownedProduction, presentProduction, productionLock, ProductionConflict, saveProduction, stateOf } from "../lib/production-store";
import { assertProductionEditable, runProductionRenderAction } from "../lib/production-render";
import { storeProductionScript } from "../lib/production-script-upload";
import { text } from "../lib/production-types";

const router: IRouter = Router();
function errorResponse(res: express.Response, error: unknown) {
  res.status(error instanceof ProductionConflict ? 409 : 400).json({ error: error instanceof Error ? error.message : "Production action failed." });
}
router.get("/production-projects", async (req, res) => {
  const rows = await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.tenantId, req.context!.tenant!.id)).orderBy(desc(productionProjectsTable.updatedAt));
  res.json(rows.map(presentProduction));
});
router.post("/production-projects", async (req, res) => {
  const parsed = CreateProductionProjectBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Provide a title and project state." }); return; }
  try {
    res.status(201).json(presentProduction(await createProduction(req.context!.tenant!.id, req.context!.user.id, parsed.data.title, parsed.data.state)));
  } catch (error) { errorResponse(res, error); }
});
router.use("/production-projects/:id", async (req, res, next) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !await ownedProduction(id, req.context!.tenant!.id)) {
    res.status(404).json({ error: "Production project not found." }); return;
  }
  next();
});
router.get("/production-projects/:id", async (req, res) => {
  const row = (await ownedProduction(String(req.params.id), req.context!.tenant!.id))!;
  if (row.renderProjectId) {
    const shots = await db.select().from(longFormShotsTable).where(eq(longFormShotsTable.projectId, row.renderProjectId));
    const state = stateOf(row);
    for (const shot of shots.filter(s => s.status === "FAILED")) state.review.issues.push({
      id: `failed-${shot.id}`, shotId: shot.id, sceneNumber: shot.sceneNumber,
      description: shot.errorMessage || "This shot failed to render.", correction: "Regenerate this shot using the approved production references.",
    });
  }
  res.json(presentProduction(row));
});
router.patch("/production-projects/:id", async (req, res) => {
  const parsed = UpdateProductionProjectBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid project update." }); return; }
  try {
    const saved = await productionLock(String(req.params.id), async () => {
      const row = (await ownedProduction(String(req.params.id), req.context!.tenant!.id))!;
      if (parsed.data.revision !== row.revision) throw new ProductionConflict("The project changed. Load the latest saved version before saving.");
      const state = stateOf(row);
      const next = applyProductionPatch(state, parsed.data.state);
      // Navigation remains available during rendering, but creative changes do not.
      const changed = JSON.stringify(next.story) !== JSON.stringify(state.story) || JSON.stringify(next.settings) !== JSON.stringify(state.settings);
      if (changed) {
        await assertProductionEditable(row);
        if (row.renderProjectId) {
          if (JSON.stringify(next.story) !== JSON.stringify(state.story)) throw new Error("This draft already has a render plan. Use the shot editor to revise story content without losing completed work.");
          await db.update(longFormProjectsTable).set({
            generationMode: next.settings.generationMode, width: next.settings.width,
            height: next.settings.height, fps: next.settings.fps, qualityPreset: next.settings.qualityPreset,
          }).where(eq(longFormProjectsTable.id, row.renderProjectId));
        }
      }
      return saveProduction(row, next, { title: text(parsed.data.title, "Title", 180) });
    });
    res.json(presentProduction(saved));
  } catch (error) { errorResponse(res, error); }
});
router.post("/production-projects/:id/script", express.raw({ type: "application/octet-stream", limit: "10mb" }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body)) throw new Error("Upload raw file bytes.");
    const saved = await productionLock(String(req.params.id), async () => {
      const row = (await ownedProduction(String(req.params.id), req.context!.tenant!.id))!;
      await assertProductionEditable(row);
      const state = stateOf(row);
      if (state.tasks.some(t => ["QUEUED", "RUNNING"].includes(t.status))) throw new Error("Wait for the current project tasks before replacing the script.");
      if (row.renderProjectId) throw new Error("A render plan already exists; revise its shots in the editor instead.");
      Object.assign(state.story, await storeProductionScript(row.tenantId, String(req.get("x-file-name") ?? ""), req.body), { draftStatus: undefined, scenes: [] });
      return saveProduction(row, state);
    });
    res.json(presentProduction(saved));
  } catch (error) { errorResponse(res, error); }
});
router.post("/production-projects/:id/actions", async (req, res) => {
  const parsed = RunProductionActionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid production action." }); return; }
  try {
    const saved = await productionLock(String(req.params.id), async () => {
      let row = (await ownedProduction(String(req.params.id), req.context!.tenant!.id))!;
      if (parsed.data.revision !== row.revision) throw new ProductionConflict("This project changed. Refresh its saved state before retrying.");
      const { action, payload = {} } = parsed.data;
      let state = stateOf(row);
      if (["create-scenes", "prepare-render", "fix-shot", "export"].includes(action)) {
        const renderId = await runProductionRenderAction(row, action, payload);
        row = (await ownedProduction(row.id, row.tenantId))!;
        return saveProduction(row, state, { renderProjectId: renderId });
      }
      await assertProductionEditable(row);
      if (action === "draft-story") {
        const storyModel = state.settings.storyModel || "local";
        if (storyModel !== "local" && payload.cloudConfirmed !== true) throw new Error("Confirm paid story drafting before submitting the screenplay batch.");
        if (row.renderProjectId) throw new Error("A render plan already exists; edit its shots instead of replacing the story.");
        if (!state.story.summary.trim() && !state.story.script.trim()) throw new Error("Enter a summary or upload a script first.");
        if (state.tasks.some(t => t.type === "story" && ["QUEUED", "RUNNING"].includes(t.status))) throw new ProductionConflict("The story is already drafting.");
        const failed = [...state.tasks].reverse().find(t => t.type === "story" && t.status === "FAILED");
        if (failed && failed.index > 0 && state.story.scenes.length) { failed.status = "QUEUED"; failed.error = undefined; }
        else addTask(state, "story");
        state.story.draftStatus = "RUNNING"; state.story.error = undefined;
        const task = [...state.tasks].reverse().find(t => t.type === "story" && ["QUEUED", "RUNNING"].includes(t.status))!;
        task.storyModel = storyModel; task.cloudConfirmed = payload.cloudConfirmed === true;
      } else if (action === "retry-task") {
        const task = state.tasks.find(t => t.id === payload.id && t.status === "FAILED");
        if (!task) throw new Error("Choose a failed task.");
        if (task.cloudConfirmed && payload.cloudConfirmed !== true) throw new Error("Confirm paid costs again before retrying this task.");
        task.status = "QUEUED"; task.error = undefined; task.jobId = undefined; task.id = randomUUID();
      } else {
        state = await mutateProductionAsset(row, action, payload);
      }
      return saveProduction(row, state);
    });
    res.json(presentProduction(saved));
  } catch (error) { errorResponse(res, error); }
});
export default router;

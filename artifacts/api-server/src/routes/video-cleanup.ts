import { Router, type IRouter } from "express";
import { InspectVideoCleanupBody, SubmitVideoCleanupBody, InspectVideoCleanupResponse, ListVideoCleanupJobsResponse } from "@workspace/api-zod";
import { inspectCleanup, listCleanupJobs, submitCleanup } from "../lib/video-cleanup-service";

const router: IRouter = Router();
function statusCode(error: unknown) {
  return error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 400;
}
router.post("/video-cleanup/inspect", async (req, res): Promise<void> => {
  const body = InspectVideoCleanupBody.strict().safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "An uploaded source video is required." }); return; }
  try {
    res.json(InspectVideoCleanupResponse.parse(await inspectCleanup(req.context!.tenant!.id, body.data.sourceStorageKey)));
  } catch (error) {
    res.status(statusCode(error)).json({ error: error instanceof Error ? error.message : "Could not inspect this clip." });
  }
});
router.post("/video-cleanup", async (req, res): Promise<void> => {
  const body = SubmitVideoCleanupBody.strict().safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Invalid cleanup selection or paid-processing confirmation." }); return; }
  try {
    const job = await submitCleanup({ ...body.data, tenantId: req.context!.tenant!.id, userId: req.context!.user.id });
    res.json({ jobId: job.id });
  } catch (error) {
    res.status(statusCode(error)).json({ error: error instanceof Error ? error.message : "Could not submit cleanup." });
  }
});
router.get("/video-cleanup/jobs", async (req, res): Promise<void> => {
  try { res.json(ListVideoCleanupJobsResponse.parse(await listCleanupJobs(req.context!.tenant!.id))); }
  catch { res.status(500).json({ error: "Could not load cleanup jobs." }); }
});
export default router;
import { Router, type IRouter } from "express";
import { bulkDeleteVideos, listVideos, setVideoFavorites, undoBulkDelete, VideoLibraryError } from "../lib/video-library-service";

const router: IRouter = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validIds(body: unknown): body is { ids: string[] } {
  if (!body || typeof body !== "object") return false;
  const ids = (body as { ids?: unknown }).ids;
  return Array.isArray(ids) && ids.length > 0 && ids.length <= 100
    && ids.every((id) => typeof id === "string" && uuid.test(id))
    && new Set(ids).size === ids.length;
}

function failure(error: unknown, res: import("express").Response): void {
  res.status(error instanceof VideoLibraryError ? error.status : 500)
    .json({ error: error instanceof VideoLibraryError ? error.message : "Video library request failed" });
}

router.get("/video-library", async (req, res) => {
  const favorite = req.query.favorite;
  if (favorite !== undefined && favorite !== "true" && favorite !== "false") {
    res.status(400).json({ error: "favorite must be true or false" }); return;
  }
  try {
    res.json({ items: await listVideos(req.context!.tenant!.id, favorite === undefined ? undefined : favorite === "true") });
  } catch (error) { failure(error, res); }
});

router.post("/video-library/favorites", async (req, res) => {
  const favorite: unknown = req.body?.favorite;
  if (!validIds(req.body) || typeof favorite !== "boolean") {
    res.status(400).json({ error: "ids must be 1–100 unique UUIDs and favorite must be boolean" }); return;
  }
  try { res.json(await setVideoFavorites(req.context!.tenant!.id, req.body.ids, favorite)); }
  catch (error) { failure(error, res); }
});

router.post("/video-library/bulk-delete", async (req, res) => {
  if (!validIds(req.body)) { res.status(400).json({ error: "ids must be 1–100 unique UUIDs" }); return; }
  try { res.json(await bulkDeleteVideos(req.context!.tenant!.id, req.body.ids)); }
  catch (error) { failure(error, res); }
});

router.post("/video-library/undo", async (req, res) => {
  if (typeof req.body?.undoToken !== "string" || !uuid.test(req.body.undoToken)) {
    res.status(400).json({ error: "undoToken must be a UUID" }); return;
  }
  try { res.json(await undoBulkDelete(req.context!.tenant!.id, req.body.undoToken)); }
  catch (error) { failure(error, res); }
});

export default router;
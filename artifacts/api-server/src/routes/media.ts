import { Router, type IRouter } from "express";
import { mediaStorage } from "../lib/storage-service";

const router: IRouter = Router();

router.get("/media/{*key}", (req, res): void => {
  const raw = Array.isArray(req.params.key) ? req.params.key.join("/") : req.params.key;
  if (!raw) {
    res.status(400).json({ error: "Media key is required" });
    return;
  }
  try {
    const stream = mediaStorage.stream(raw);
    stream.on("error", () => res.status(404).json({ error: "Media not found" }));
    if (raw.endsWith(".mp4")) res.type("video/mp4");
    if (raw.endsWith(".webm")) res.type("video/webm");
    stream.pipe(res);
  } catch {
    res.status(400).json({ error: "Invalid media path" });
  }
});

export default router;
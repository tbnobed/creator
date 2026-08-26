import { Router, type IRouter } from "express";
import healthRouter from "./health";
import charactersRouter from "./characters";
import settingsRouter from "./settings";
import serversRouter from "./servers";
import workflowsRouter from "./workflows";
import generationsRouter from "./generations";
import mediaRouter from "./media";
import referenceVideosRouter from "./reference-videos";
import longFormProjectsRouter from "./long-form-projects";

const router: IRouter = Router();

router.use(healthRouter);
router.use(charactersRouter);
router.use(settingsRouter);
router.use(serversRouter);
router.use(workflowsRouter);
router.use(generationsRouter);
router.use(referenceVideosRouter);
router.use(longFormProjectsRouter);
router.use(mediaRouter);

export default router;

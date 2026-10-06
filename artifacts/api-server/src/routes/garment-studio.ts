import { Router, type IRouter } from "express";
import { InspectGarmentSourceBody, SubmitGarmentJobBody } from "@workspace/api-zod";
import { cancelGarment, inspectGarment, listGarmentJobs, listGarmentWorkers, submitGarment } from "../lib/garment-service";
import { GarmentError } from "../lib/garment-media";

const router: IRouter = Router();
function respond(error: unknown, res: import("express").Response) {
  res.status(error instanceof GarmentError ? error.statusCode : 500).json({
    error: error instanceof GarmentError ? error.message : "Video processing failed. Check the saved job before retrying.",
  });
}
router.get("/garment-studio/workers",async (_req,res)=>{
  try { res.json(await listGarmentWorkers()); } catch(error) {respond(error,res);}
});
router.post("/garment-studio/inspect",async(req,res)=>{
  const body=InspectGarmentSourceBody.strict().safeParse(req.body);
  if(!body.success) {res.status(400).json({error:"Select an uploaded source video."});return;}
  try {res.json(await inspectGarment(req.context!.tenant!.id,body.data.sourceStorageKey));}
  catch(error) {respond(error,res);}
});
router.get("/garment-studio/jobs",async(req,res)=>{
  try {res.json(await listGarmentJobs(req.context!.tenant!.id));} catch(error) {respond(error,res);}
});
router.post("/garment-studio/jobs",async(req,res)=>{
  const body=SubmitGarmentJobBody.strict().safeParse(req.body);
  if(!body.success) {res.status(400).json({error:"Invalid video replacement request, range, seed or model."});return;}
  if(!body.data.prompt.trim()) {res.status(400).json({error:"Describe what should be replaced or how the artwork should move."});return;}
  try {res.json(await submitGarment({...body.data,tenantId:req.context!.tenant!.id,userId:req.context!.user.id}));}
  catch(error) {respond(error,res);}
});
router.post("/garment-studio/jobs/:id/cancel",async(req,res)=>{
  if(!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) {res.status(400).json({error:"Invalid job ID."});return;}
  try {res.json(await cancelGarment(String(req.params.id),req.context!.tenant!.id));}
  catch(error) {respond(error,res);}
});
export default router;
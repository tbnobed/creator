import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, pool, comfyServersTable, generationJobsTable, type GenerationJob } from "@workspace/db";
import { ComfyUIClient, isTransientComfyUIRequestError } from "./comfy/client";
import { mediaStorage } from "./storage-service";
import { probeVideoMediaProperties } from "./video-media-probe";
import { assertGarmentKey, buildGarmentGraph, checkGarmentRuntime, GarmentError, garmentFrames, prepareGarmentSource, prepareGarmentReference, renderGarmentPrint } from "./garment-media";
import { comfyServerLockKey, getAssignableWorker, liveWorker, liveWorkerById } from "./worker-lifecycle";
import { logger } from "./logger";

const operation = "garment-studio";
const active = ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"];
const monitors = new Map<string, AbortController>();
type Submission = {
  requestId: string; sourceStorageKey: string; referenceStorageKey?: string; workerId: string;
  artworkSource?: "existing" | "upload";
  targetGarment: string;
  mode: "replace-garment" | "animate-artwork"; prompt: string; startSeconds: number;
  durationSeconds: number; seed: number; tenantId: string; userId: string;
};
const jobWhere = (id: string) => and(eq(generationJobsTable.id, id), inArray(generationJobsTable.status, active));
const message = (error: unknown) => error instanceof Error ? error.message : "Local garment processing failed.";
async function getJob(id: string, tenantId?: string) {
  const [job] = await db.select().from(generationJobsTable).where(and(eq(generationJobsTable.id,id),
    ...(tenantId ? [eq(generationJobsTable.tenantId,tenantId)] : [])));
  if (!job || job.providerTaskMetadata.operation !== operation) throw new GarmentError(404,"Garment job not found.");
  return job;
}
async function source(tenantId: string, key: string) {
  assertGarmentKey(key, tenantId);
  const media = await mediaStorage.readGenerationReferenceMedia(key);
  if (media.bytes.length > 200*1024*1024) throw new GarmentError(400,"Use a source video smaller than 200 MB.");
  return media;
}
export async function inspectGarment(tenantId: string, key: string) {
  const media = await source(tenantId,key);
  const p = await probeVideoMediaProperties(media.bytes);
  if (!p.width || !p.height || !Number.isFinite(p.durationSeconds) || p.durationSeconds < .5
      || Math.max(p.width,p.height) > 4096) throw new GarmentError(400,"Use a measurable video of at least 0.5 seconds, up to 4096px.");
  return {sourceStorageKey:key,mediaUrl:`/api/media/${key}`,durationSeconds:p.durationSeconds,width:p.width,height:p.height};
}
async function workerReady(server: typeof comfyServersTable.$inferSelect) {
  if (!server.enabled || server.status !== "ONLINE") return {ready:false,busy:false,reason:"Worker must be enabled and online."};
  try {
    const client = new ComfyUIClient(server), info = await client.getObjectInfo();
    for (const [node, field, file] of [
      ["UNETLoader","unet_name","wan2.1_vace_14B_fp16.safetensors"],
      ["VAELoader","vae_name","wan_2.1_vae.safetensors"],
      ["CheckpointLoaderSimple","ckpt_name","sam3.1_multiplex_fp16.safetensors"],
      ["CLIPLoader","clip_name","umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
    ]) {
      const spec = info[node]?.input?.required?.[field];
      const config = spec?.[1] as {options?: unknown[]}|undefined;
      const choices = Array.isArray(spec?.[0]) ? spec[0] as unknown[] : config?.options ?? [];
      if (!choices.includes(file)) return {ready:false,busy:false,reason:`Required model unavailable: ${file}`};
    }
    for (const node of ["SAM3_VideoTrack","SAM3_TrackToMask","WanVaceToVideo","LoadVideo","CreateVideo","SaveVideo","ImageCompositeMasked","InvertMask","ImageFromBatch"]) {
      if (!info[node]) return {ready:false,busy:false,reason:`Required node unavailable: ${node}`};
    }
    const queue = await client.getQueue();
    const claims = await db.select({id:generationJobsTable.id}).from(generationJobsTable).where(and(
      eq(generationJobsTable.comfyServerId,server.id),inArray(generationJobsTable.status,active))).limit(1);
    const busy = Boolean(queue.queue_running?.length || queue.queue_pending?.length || claims.length || server.activeJobCount);
    return {ready:true,busy,reason:busy ? "Worker is processing another job." : null};
  } catch { return {ready:false,busy:false,reason:"Cannot verify this worker from the API server."}; }
}
export async function listGarmentWorkers() {
  const servers = await db.select().from(comfyServersTable).where(liveWorker());
  let runtimeError: string | null = null;
  try { await checkGarmentRuntime(); } catch (error) {
    runtimeError = error instanceof GarmentError ? error.message : "App server garment runtime check failed.";
  }
  return Promise.all(servers.map(async server => ({id:server.id,name:server.displayName,
    ...(runtimeError ? {ready:false,busy:false,reason:runtimeError} : await workerReady(server))})));
}
export async function listGarmentJobs(tenantId: string) {
  const rows = await db.select().from(generationJobsTable).where(and(
    eq(generationJobsTable.tenantId,tenantId),eq(generationJobsTable.providerModelId,operation)))
    .orderBy(desc(generationJobsTable.createdAt)).limit(250);
  return rows.filter(j=>j.providerTaskMetadata.operation===operation).map(j=>({
    id:j.id,title:j.title,mode:j.generationMode as Submission["mode"],
    status:({UPLOADING:"queued",QUEUED:"queued",RUNNING:"running",DOWNLOADING:"running",COMPLETED:"succeeded",CANCELLED:"cancelled"} as Record<string,string>)[j.status]??"failed",
    stage:j.currentNode,sourceUrl:`/api/media/${j.providerTaskMetadata.preparedKey ?? j.providerTaskMetadata.sourceStorageKey}`,
    maskUrl:typeof j.providerTaskMetadata.maskKey==="string"?`/api/media/${j.providerTaskMetadata.maskKey}`:null,
    outputUrl:j.status==="COMPLETED"&&j.outputStorageKey?`/api/media/${j.outputStorageKey}`:null,
    error:j.errorMessage,createdAt:j.createdAt.toISOString(),
  }));
}
export async function submitGarment(input: Submission) {
  assertGarmentKey(input.sourceStorageKey,input.tenantId);
  garmentFrames(input.durationSeconds);
  if (input.mode==="replace-garment") {
    if (!input.referenceStorageKey) throw new GarmentError(400,"Upload a target garment reference image.");
    assertGarmentKey(input.referenceStorageKey,input.tenantId,true);
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({...input,userId:undefined})).digest("hex");
  const [existing] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id,input.requestId));
  if (existing) {
    if (existing.tenantId!==input.tenantId || existing.providerTaskMetadata.fingerprint!==fingerprint) throw new GarmentError(409,"Request ID belongs to different processing.");
    return {jobId:existing.id};
  }
  if (!input.prompt.trim()) throw new GarmentError(400,"Describe the garment or how its artwork should move.");
  if (!input.targetGarment.trim() || input.targetGarment.length > 160) throw new GarmentError(400,"Identify the garment to edit.");
  if (input.mode === "animate-artwork") {
    if (input.artworkSource === "upload") {
      if (!input.referenceStorageKey) throw new GarmentError(400,"Upload the artwork you want to animate.");
      assertGarmentKey(input.referenceStorageKey,input.tenantId,true);
    } else if (input.referenceStorageKey) {
      throw new GarmentError(400,"Choose uploaded artwork to use this reference, or remove the image.");
    }
  }
  await checkGarmentRuntime();
  const lock = await pool.connect();
  let claimed = false, attempted = false, created = false;
  try {
    const r = await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked",[comfyServerLockKey(input.workerId)]);
    claimed = r.rows[0]?.locked === true;
    if (!claimed) throw new GarmentError(409,"Worker is being assigned. Refresh worker availability.");
    const server = await getAssignableWorker(input.workerId);
    if (!server) throw new GarmentError(409,"Worker is not available.");
    const state = await workerReady(server);
    if (!state.ready || state.busy) throw new GarmentError(409,state.reason??"Worker unavailable.");
    const [job] = await db.insert(generationJobsTable).values({
      id:input.requestId,tenantId:input.tenantId,createdByUserId:input.userId,comfyServerId:server.id,
      title:input.mode==="replace-garment"?"Garment replacement draft":"Animated artwork draft",
      status:"UPLOADING",provider:"COMFYUI",providerModelId:operation,prompt:input.prompt,compiledPrompt:input.prompt,
      generationMode:input.mode,qualityPreset:"DRAFT",width:512,height:288,fps:16,
      frameCount:garmentFrames(input.durationSeconds),durationSeconds:garmentFrames(input.durationSeconds)/16,seed:input.seed,
      providerTaskMetadata:{operation,fingerprint,sourceStorageKey:input.sourceStorageKey,request:input,
        artworkRenderer:input.mode==="animate-artwork"?"vace-instruction":null},
      currentNode:"Preparing selected source window",
    }).onConflictDoNothing().returning();
    if (!job) throw new GarmentError(409,"Request already exists; reload saved jobs.");
    created=true;
    const raw = await source(input.tenantId,input.sourceStorageKey);
    const prepared = await prepareGarmentSource(raw.bytes,input.startSeconds,input.durationSeconds);
    const preparedKey = await mediaStorage.storeGenerationReferenceMedia("video/mp4",prepared.bytes,input.tenantId);
    const client = new ComfyUIClient(server);
    const uploaded = await client.uploadVideo({name:`garment-${job.id}.mp4`,mimeType:"video/mp4",bytes:prepared.bytes});
    let reference: string | undefined;
    if (input.referenceStorageKey) {
      const image = await mediaStorage.readGenerationReferenceMedia(input.referenceStorageKey);
      const referenceBytes = await prepareGarmentReference(image.bytes);
      reference=(await client.uploadImage({name:`garment-reference-${job.id}.png`,mimeType:"image/png",bytes:referenceBytes})).name;
    }
    const graph = await buildGarmentGraph({filename:uploaded.name,prefix:`garment/${job.id}`,prompt:input.prompt,
      seed:input.seed,frames:prepared.frames,reference,mode:input.mode,targetGarment:input.targetGarment.trim()});
    const [intent] = await db.update(generationJobsTable).set({
      providerTaskMetadata:{...job.providerTaskMetadata,preparedKey,submissionIntent:true},
      currentNode:"Submitting local garment workflow",
    }).where(jobWhere(job.id)).returning();
    if (!intent) return {jobId:job.id};
    attempted=true;
    const receipt = await client.submitWorkflow(graph,job.id);
    if (!receipt.prompt_id) throw new Error("Worker returned no prompt receipt.");
    // Persist even if cancellation raced with submission; recover cancellation on restart.
    await db.update(generationJobsTable).set({comfyPromptId:receipt.prompt_id}).where(eq(generationJobsTable.id,job.id));
    const [queued] = await db.update(generationJobsTable).set({status:"QUEUED",queuedAt:new Date(),
      currentNode:input.mode==="animate-artwork"?"Animating artwork from your instructions":"Tracking and replacing garment"}).where(jobWhere(job.id)).returning();
    if (queued) startGarmentMonitor(job.id); else await cancelGarment(job.id,input.tenantId);
    return {jobId:job.id};
  } catch(error) {
    if (created) await db.update(generationJobsTable).set({status:"FAILED",failedAt:new Date(),currentNode:null,
      errorMessage:attempted?"Submission outcome uncertain. Do not resubmit; check the saved job and worker history.":message(error)}).where(jobWhere(input.requestId));
    throw error;
  } finally {
    if (claimed) await lock.query("SELECT pg_advisory_unlock(hashtext($1))",[comfyServerLockKey(input.workerId)]);
    lock.release();
  }
}
function outputFile(record: Record<string, unknown>, node: string) {
  const outputs = record.outputs as Record<string,{images?: Array<{filename:string;subfolder?:string;type?:string}>}>|undefined;
  const file=outputs?.[node]?.images?.find(f=>f.type==="output"&&f.filename.endsWith(".mp4"));
  if (!file) throw new Error(`Worker did not return expected garment output ${node}.`);
  return file;
}
async function monitorGarment(id: string, signal: AbortSignal) {
  const deadline=Date.now()+60*60*1000;
  while (!signal.aborted && Date.now()<deadline) {
    const job=await getJob(id);
    if (!active.includes(job.status)) return;
    const [server]=await db.select().from(comfyServersTable).where(liveWorkerById(job.comfyServerId!));
    if (!server || !job.comfyPromptId) throw new Error("Saved worker receipt is unavailable.");
    const client=new ComfyUIClient(server);
    let history: Record<string,unknown>;
    try { history=await client.getHistory(job.comfyPromptId); }
    catch(error) {
      if (!isTransientComfyUIRequestError(error)) throw error;
      await new Promise(r=>setTimeout(r,5000));continue;
    }
    const record=history[job.comfyPromptId] as Record<string,unknown>|undefined;
    if (record) {
      const status=record.status as {status_str?:string;completed?:boolean}|undefined;
      if(status?.status_str!=="success" || !status.completed) throw new Error("Local garment workflow failed. Review the worker execution history.");
      await db.update(generationJobsTable).set({status:"DOWNLOADING",currentNode:job.generationMode==="animate-artwork"?"Applying moving print to cloth":"Saving garment replacement"}).where(jobWhere(id));
      const mf=outputFile(record,"9"), mask=await client.getOutputFile(mf.filename,mf.subfolder,mf.type);
      const maskKey=await mediaStorage.storeOutput("mask.mp4","video/mp4",mask,job.tenantId);
      await db.update(generationJobsTable).set({providerTaskMetadata:{...job.providerTaskMetadata,maskKey}}).where(jobWhere(id));
      const sourceMedia=await mediaStorage.readGenerationReferenceMedia(String(job.providerTaskMetadata.preparedKey));
      let bytes: Buffer;
      // Old accepted mask-only jobs retain their original finalizer on recovery.
      // New artwork jobs use instruction-conditioned GPU output, never the canned demo.
      if (job.generationMode==="animate-artwork" && job.providerTaskMetadata.artworkRenderer!=="vace-instruction") bytes=await renderGarmentPrint(sourceMedia.bytes,mask,signal);
      else { const f=outputFile(record,"22");bytes=await client.getOutputFile(f.filename,f.subfolder,f.type); }
      const p=await probeVideoMediaProperties(bytes);
      const original=await probeVideoMediaProperties(sourceMedia.bytes);
      if(p.width!==512||p.height!==288||Math.abs(p.durationSeconds-job.durationSeconds)>.15
        ||(p.audioStreams??0)!==(original.audioStreams??0)) throw new Error("Output framing, duration or audio validation failed.");
      if(signal.aborted) return;
      const outputStorageKey=await mediaStorage.storeOutput("garment.mp4","video/mp4",bytes,job.tenantId);
      await db.update(generationJobsTable).set({status:"COMPLETED",completedAt:new Date(),progress:1,currentNode:null,
        outputStorageKey,outputMimeType:"video/mp4",errorMessage:null}).where(jobWhere(id));
      return;
    }
    await db.update(generationJobsTable).set({status:"RUNNING",startedAt:job.startedAt??new Date()}).where(jobWhere(id));
    await new Promise(r=>setTimeout(r,3000));
  }
  if(!signal.aborted) throw new Error("Local garment job timed out; no replacement job was submitted.");
}
function startGarmentMonitor(id: string) {
  if(monitors.has(id)) return;
  const controller=new AbortController();monitors.set(id,controller);
  void monitorGarment(id,controller.signal).catch(async error=>{
    if(!controller.signal.aborted) {
      if (isTransientComfyUIRequestError(error)) {
        logger.warn({err:error,jobId:id},"Garment transfer interrupted; retaining the original worker receipt");
        setTimeout(()=>startGarmentMonitor(id),5000).unref();
        return;
      }
      logger.error({err:error,jobId:id},"Garment processing failed");
      await db.update(generationJobsTable).set({status:"FAILED",errorMessage:message(error),failedAt:new Date(),currentNode:null}).where(jobWhere(id));
    }
  }).finally(()=>monitors.delete(id));
}
export async function cancelGarment(id: string, tenantId: string) {
  const job=await getJob(id,tenantId);
  if(!active.includes(job.status)&&job.status!=="CANCELLED") throw new GarmentError(409,"Only active garment jobs can be cancelled.");
  await db.update(generationJobsTable).set({status:"CANCELLED",currentNode:null,errorMessage:"Cancellation requested."}).where(jobWhere(id));
  monitors.get(id)?.abort();
  if(job.comfyServerId&&job.comfyPromptId) {
    const [server]=await db.select().from(comfyServersTable).where(liveWorkerById(job.comfyServerId));
    if(server) {
      const client=new ComfyUIClient(server), queue=await client.getQueue();
      await client.removeQueuedPrompt(job.comfyPromptId);
      if(queue.queue_running?.some(row=>Array.isArray(row)&&row[1]===job.comfyPromptId)) await client.interrupt(job.comfyPromptId);
      else await db.update(generationJobsTable).set({
        providerTaskMetadata:{...job.providerTaskMetadata,cancellationConfirmed:true},
        errorMessage:"Cancelled.",
      }).where(and(eq(generationJobsTable.id,id),eq(generationJobsTable.status,"CANCELLED")));
    }
  }
  return {jobId:id};
}
export async function resumeGarmentJobs() {
  const rows=await db.select().from(generationJobsTable).where(inArray(generationJobsTable.status,[...active,"CANCELLED"]));
  for(const job of rows.filter(j=>j.providerTaskMetadata.operation===operation)) {
    if(job.status==="CANCELLED"&&job.comfyPromptId&&!job.providerTaskMetadata.cancellationConfirmed) {
      await cancelGarment(job.id,job.tenantId).catch(error=>logger.warn({err:error,jobId:job.id},"Garment cancellation remains unconfirmed"));
    } else if(job.comfyPromptId) startGarmentMonitor(job.id);
  }
}
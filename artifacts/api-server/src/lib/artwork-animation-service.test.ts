import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db, pool, usersTable, tenantsTable, generationJobsTable } from "@workspace/db";
import { validatePixelAnimation, reuseArtworkSource, startPixelAnimation } from "./artwork-animation-service";
import { submitGarment, listGarmentJobs, cancelGarment } from "./garment-service";
import { mediaStorage } from "./storage-service";
import { SubmitGarmentJobBody } from "@workspace/api-zod";

test("original-pixel workflow: contract, real CPU render, tenant isolation, idempotency, cancellation and recovery", {timeout:120_000}, async () => {
  const tenantId=randomUUID(), other=randomUUID(), userId=`artwork-test-${randomUUID()}`;
  const dir=await mkdtemp(path.join(tmpdir(),"artwork-test-"));
  const exec=promisify(execFile);
  const files:string[]=[];
  const ids:string[]=[];
  try {
    await db.insert(usersTable).values({id:userId, displayName:"Isolated artwork fixture"});
    await db.insert(tenantsTable).values([{id:tenantId,name:"Artwork fixture",slug:`test-${tenantId}`},{id:other,name:"Artwork other",slug:`test-${other}`}]);
    const filename=path.join(dir,"fixture.mp4");
    await exec("ffmpeg",["-v","error","-y","-f","lavfi","-i","color=c=white:s=320x180:r=24:d=1",
      "-f","lavfi","-i","sine=frequency=440:duration=1","-vf","drawbox=x=150:y=75:w=40:h=12:color=blue:t=fill",
      "-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",filename]);
    const key=await mediaStorage.storeGenerationReferenceMedia("video/mp4",await readFile(filename),tenantId);
    files.push(key);
    const body={requestId:randomUUID(),provider:"LOCAL" as const,mode:"animate-artwork" as const,
      artworkSource:"existing" as const,sourceStorageKey:key,prompt:"Small arm wave",targetGarment:"printed jacket",
      startSeconds:0,durationSeconds:1,seed:0,
      pixelAnimation:{polygon:[{x:.46,y:.39},{x:.61,y:.39},{x:.61,y:.51},{x:.46,y:.51}],
        pivot:{x:.47,y:.46},angleDegrees:15,cyclesPerSecond:1,inkThreshold:20}};
    const input={...body,tenantId,userId};
    assert.ok(SubmitGarmentJobBody.strict().safeParse(body).success);
    validatePixelAnimation(input);
    assert.throws(()=>validatePixelAnimation({...input,provider:"FAL"}),/locally/);
    assert.throws(()=>validatePixelAnimation({...input,durationSeconds:6}),/0.5 to 5/);
    assert.throws(()=>validatePixelAnimation({...input,pixelAnimation:{...input.pixelAnimation,angleDegrees:0}}),/valid/);
    assert.throws(()=>validatePixelAnimation({...input,pixelAnimation:{...input.pixelAnimation,polygon:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]}}),/valid/);
    assert.throws(()=>validatePixelAnimation({...input,pixelAnimation:{...input.pixelAnimation,cleanPlateStorageKey:`tenants/${other}/generation-references/${randomUUID()}.png`}}),/belonging/);
    ids.push(body.requestId);
    assert.deepEqual(await submitGarment(input),{jobId:body.requestId});
    assert.deepEqual(await submitGarment(input),{jobId:body.requestId});
    await assert.rejects(submitGarment({...input,prompt:"different"}),/different processing/);
    await assert.rejects(cancelGarment(body.requestId,other),/not found/);
    async function wait(id:string) {
      for(let n=0;n<400;n++){
        const [j]=await db.select().from(generationJobsTable).where(eq(generationJobsTable.id,id));
        if(["COMPLETED","FAILED","CANCELLED"].includes(j.status)) return j;
        await new Promise(r=>setTimeout(r,150));
      }
      throw new Error("Render timed out");
    }
    const job=await wait(body.requestId);
    assert.equal(job.status,"COMPLETED",job.errorMessage??"");
    files.push(job.outputStorageKey!,String(job.providerTaskMetadata.preparedKey));
    const metrics=job.providerTaskMetadata.verification as {outsideMaskUnchangedBeforeEncoding:boolean;maxEditedPixels:number};
    assert.equal(metrics.outsideMaskUnchangedBeforeEncoding,true);
    assert.ok(metrics.maxEditedPixels>0);
    assert.equal((await listGarmentJobs(other)).length,0);
    assert.equal((await listGarmentJobs(tenantId))[0].model,"Original pixels · CPU");
    await assert.rejects(reuseArtworkSource(other,body.requestId),/not found/);
    const reused=await reuseArtworkSource(tenantId,body.requestId); files.push(reused.sourceStorageKey);
    assert.equal(reused.width,1280);
    await assert.rejects(cancelGarment(body.requestId,tenantId),/Only active/);
    // Simulate a persisted queued job on restart: original input is sufficient.
    const restored=randomUUID(); ids.push(restored);
    await db.insert(generationJobsTable).values({...job,id:restored,status:"QUEUED",outputStorageKey:null,completedAt:null,
      providerTaskMetadata:{...job.providerTaskMetadata,request:{...input,requestId:restored}}});
    startPixelAnimation(restored);
    const recovered=await wait(restored);
    assert.equal(recovered.status,"COMPLETED",recovered.errorMessage??"");
    files.push(recovered.outputStorageKey!,String(recovered.providerTaskMetadata.preparedKey));
    const cancelled=randomUUID(); ids.push(cancelled);
    await db.insert(generationJobsTable).values({...job,id:cancelled,status:"QUEUED",outputStorageKey:null,completedAt:null});
    await cancelGarment(cancelled,tenantId);
    startPixelAnimation(cancelled);
    assert.equal((await wait(cancelled)).status,"CANCELLED");
  } finally {
    // Let async monitor finally blocks release connections before fixture teardown.
    await new Promise(r=>setTimeout(r,500));
    for(const key of files) await rm(mediaStorage.resolvePath(key),{force:true});
    if(ids.length) await db.delete(generationJobsTable).where(inArray(generationJobsTable.id,ids));
    await db.delete(tenantsTable).where(inArray(tenantsTable.id,[tenantId,other]));
    await db.delete(usersTable).where(eq(usersTable.id,userId));
    await rm(dir,{recursive:true,force:true});
    await pool.end();
  }
});

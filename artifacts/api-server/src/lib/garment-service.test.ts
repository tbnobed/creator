import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, pool, tenantsTable, usersTable, generationJobsTable } from "@workspace/db";
import { ListGarmentJobsResponse } from "@workspace/api-zod";
import { cancelGarment, listGarmentJobs, submitGarment } from "./garment-service";

test("development DB: garment ownership, saved results, idempotency and cancellation", {
  skip: process.env.NODE_ENV === "production",
}, async()=>{
  const a=randomUUID(), b=randomUUID(), user=`garment-test-${randomUUID()}`, id=randomUUID();
  const input={requestId:id,tenantId:a,userId:user,sourceStorageKey:`tenants/${a}/generation-references/${randomUUID()}.mp4`,
    workerId:randomUUID(),mode:"animate-artwork" as const,prompt:"",targetGarment:"jacket",startSeconds:0,durationSeconds:3,seed:42};
  try {
    await db.insert(usersTable).values({id:user,displayName:"Isolated garment integration fixture"});
    await db.insert(tenantsTable).values([{id:a,name:"Garment fixture A",slug:`test-${a}`},{id:b,name:"Garment fixture B",slug:`test-${b}`}]);
    await db.insert(generationJobsTable).values({
      id,tenantId:a,createdByUserId:user,title:"Isolated garment job fixture",status:"RUNNING",
      providerModelId:"garment-studio",prompt:"",compiledPrompt:"",generationMode:"animate-artwork",
      width:512,height:288,fps:16,frameCount:49,durationSeconds:49/16,qualityPreset:"DRAFT",
      providerTaskMetadata:{operation:"garment-studio",sourceStorageKey:input.sourceStorageKey,
        fingerprint:createHash("sha256").update(JSON.stringify({...input,userId:undefined})).digest("hex")},
    });
    assert.deepEqual(await submitGarment(input),{jobId:id}); // No worker exists: retry must not submit.
    await assert.rejects(submitGarment({...input,requestId:randomUUID()}),/Describe/);
    await assert.rejects(submitGarment({...input,requestId:randomUUID(),prompt:"Animate the birds",artworkSource:"upload"}),/Upload the artwork/);
    await assert.rejects(submitGarment({...input,requestId:randomUUID(),prompt:"Animate the birds",artworkSource:"upload",
      referenceStorageKey:`tenants/${b}/generation-references/${randomUUID()}.png`}),/belonging/);
    await assert.rejects(submitGarment({...input,requestId:randomUUID(),prompt:"Animate the birds",artworkSource:"existing",
      referenceStorageKey:`tenants/${a}/generation-references/${randomUUID()}.png`}),/Choose uploaded/);
    await assert.rejects(submitGarment({...input,seed:99}),/different processing/);
    await assert.rejects(cancelGarment(id,b),/not found/);
    assert.equal((await listGarmentJobs(b)).length,0);
    ListGarmentJobsResponse.parse(await listGarmentJobs(a));
    assert.equal((await listGarmentJobs(a))[0].status,"running");
    assert.deepEqual(await cancelGarment(id,a),{jobId:id});
    assert.deepEqual(await cancelGarment(id,a),{jobId:id});
    assert.equal((await listGarmentJobs(a))[0].status,"cancelled");
    await db.update(generationJobsTable).set({status:"COMPLETED",outputStorageKey:`tenants/${a}/generations/${randomUUID()}.mp4`}).where(eq(generationJobsTable.id,id));
    await assert.rejects(cancelGarment(id,a),/Only active/);
    const saved=await listGarmentJobs(a);
    ListGarmentJobsResponse.parse(saved);
    assert.equal(saved[0].status,"succeeded");
    assert.ok(saved[0].outputUrl);
    assert.deepEqual(await listGarmentJobs(a),saved);
  } finally {
    await db.delete(generationJobsTable).where(eq(generationJobsTable.id,id));
    await db.delete(tenantsTable).where(inArray(tenantsTable.id,[a,b]));
    await db.delete(usersTable).where(eq(usersTable.id,user));
    await pool.end();
  }
});
import { randomUUID } from "node:crypto";
import { db, pool, productionProjectsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createImageJob, getImageJob } from "../lib/image-studio-service";
import { stateOf } from "../lib/production-store";
async function main() {
  const [row]=await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.id,process.argv[2]));
  if(!row)throw new Error("Verification project missing");
  const outfit=stateOf(row).wardrobes[0];
  if(!outfit?.assetId || outfit.assetId!==outfit.approvedAssetId)throw new Error("Approved outfit missing");
  const job=await createImageJob({tenantId:row.tenantId,userId:row.createdByUserId,referenceMode:"native-reference-edit",request:{
    modelId:"local-flux2-klein-4b",operation:"edit",count:1,width:1024,height:1024,seed:481921,
    referenceAssetIds:[outfit.assetId],requestKey:randomUUID(),
    prompt:"Keep the exact wooden toy robot, royal blue vest, face, proportions, pose and neutral background in the reference image unchanged. Add exactly one small solid red wooden sphere on the floor next to its right foot. The ball diameter is one quarter of the robot's standing height. The ball is uniformly red with no white patches, no stripes, no holes, no panels. Full body reference photograph, no text.",
  }});
  console.log("Native local prop reference job",job.id);
  for(let i=0;i<240;i++){
    const result=await getImageJob(row.tenantId,job.id);
    if(result?.status==="FAILED" || result?.status==="CANCELLED")throw new Error(result.errorMessage||result.status);
    if(result?.status==="COMPLETED"){console.log(JSON.stringify(result.assets));return;}
    await new Promise(r=>setTimeout(r,5000));
  }
  throw new Error("Timed out. Inspect existing job rather than resubmitting.");
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());

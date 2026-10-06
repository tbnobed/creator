// One authorized clean-fabric image; fixed requestKey prevents repeated payment.
import { readFile, writeFile } from "node:fs/promises";
import { eq } from "../artifacts/api-server/node_modules/drizzle-orm/index.js";
import { db,pool,generationJobsTable,imageStudioJobsTable } from "../lib/db/src";
import { createImageJob,createUploadedAsset,getImageJob } from "../artifacts/api-server/src/lib/image-studio-service";
import { mediaStorage } from "../artifacts/api-server/src/lib/storage-service";
import { quoteImageSpend } from "../artifacts/api-server/src/lib/spending-pricing";
const root="attached_assets/existing-print-wave-proof";
const requestKey="e41830b2-3ae2-44e2-ae7c-0953422da55f";
async function main(){
  const [source]=await db.select().from(generationJobsTable).where(eq(generationJobsTable.id,"a0f5c762-bd61-4a52-b183-6e10c3417c2d"));
  if(!source?.createdByUserId)throw new Error("Approved source unavailable.");
  const [saved]=await db.select().from(imageStudioJobsTable).where(eq(imageStudioJobsTable.requestKey,requestKey));
  let id=saved?.id;
  if(!id){
    if(process.env.APPROVED_FABRIC_PATCH!=="one-image")throw new Error("Approval gate required.");
    const quote=await quoteImageSpend("cloud-nano-banana-2",{operation:"edit",width:512,height:512,count:1,referenceCount:1});
    if(quote.estimatedUsd>.081)throw new Error("Allowance exceeded.");
    const asset=await createUploadedAsset({tenantId:source.tenantId,userId:source.createdByUserId,name:"Fabric-patch source crop.png",mimeType:"image/png",bytes:await readFile(`${root}/fabric-source.png`)});
    const result=await createImageJob({tenantId:source.tenantId,userId:source.createdByUserId,request:{
      requestKey,modelId:"cloud-nano-banana-2",operation:"edit",width:512,height:512,count:1,cloudConfirmed:true,referenceAssetIds:[asset.id],
      prompt:"Remove the printed monkey illustrations from this shirt crop, leaving plain white shirt fabric. Reconstruct natural white woven cloth and subtle folds and shadows where the gray monkey and colored print were. Keep the exact crop, camera geometry, fabric folds, lighting, shirt button and dark placket seam unchanged. No new artwork, text, objects or patterns. This is a clean fabric background plate for compositing.",
    }});
    id=result.id;
    await writeFile(`${root}/fabric-receipt.json`,JSON.stringify({jobId:id,localAllowanceUsd:quote.estimatedUsd},null,2));
  }
  for(let i=0;i<90;i++){
    const job=await getImageJob(source.tenantId,id);
    if(!job)throw new Error("Saved job missing; do not retry.");
    if(job.status==="COMPLETED"){
      if(!job.assets[0])throw new Error("No image in completed job.");
      await writeFile(`${root}/fabric-clean.png`,await mediaStorage.readBuffer(job.assets[0].storageKey));
      console.log("COMPLETE: clean fabric image saved.");return;
    }
    if(["FAILED","CANCELLED"].includes(job.status))throw new Error(job.errorMessage??job.status);
    await new Promise(r=>setTimeout(r,5000));
  }
  console.log("Still pending; monitor saved job, do not create another.");
}
main().catch(e=>{console.error(String(e).replace(/https?:\/\/[^\s"']+/g,"[URL]"));process.exitCode=1;}).finally(()=>pool.end());

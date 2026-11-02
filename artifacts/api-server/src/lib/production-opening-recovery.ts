import { and, eq, inArray } from "drizzle-orm";
import { db, imageStudioAssetsTable, imageStudioJobsTable, type ProductionProjectRow } from "@workspace/db";
import { openingInputs } from "./production-openings";
import { openingHistory } from "./production-opening-history";
import type { ProductionState } from "./production-types";

/** Older builds retained images in Image Studio, but not on the scene itself. */
export async function recoverOpeningHistory(row: ProductionProjectRow, state: ProductionState) {
  const missing=state.tasks.filter(task=>task.type==="opening" && task.status==="COMPLETED"
    && state.story.scenes.some(scene=>String(scene.sceneNumber)===task.entityId
      && !openingHistory(scene).some(item=>item.id===task.id)));
  if(!missing.length)return;
  const keys=missing.map(task=>`${task.id.slice(0,-2)}00`);
  const images=await db.select({job:imageStudioJobsTable,asset:imageStudioAssetsTable})
    .from(imageStudioJobsTable).innerJoin(imageStudioAssetsTable,eq(imageStudioAssetsTable.jobId,imageStudioJobsTable.id))
    .where(and(eq(imageStudioJobsTable.tenantId,row.tenantId),eq(imageStudioAssetsTable.tenantId,row.tenantId),
      eq(imageStudioJobsTable.status,"COMPLETED"),inArray(imageStudioJobsTable.requestKey,keys)));
  for(const task of missing){
    const scene=state.story.scenes.find(scene=>String(scene.sceneNumber)===task.entityId)!;
    const found=images.find(item=>item.job.requestKey===`${task.id.slice(0,-2)}00`);
    if(!found)continue;
    const history=openingHistory(scene);
    const existing=history.find(item=>item.assetId===found.asset.id);
    if(existing){existing.id=task.id;continue;}
    let sourceKey=`unverified-legacy-${found.job.id}`;
    try{
      const inputs=openingInputs(state,scene);
      if(found.job.prompt===inputs.prompt && found.job.width===state.settings.width && found.job.height===state.settings.height
        && JSON.stringify(found.job.referenceAssetIds)===JSON.stringify(inputs.ids)
        && JSON.stringify(found.job.providerTaskMetadata.nativeComposition)===JSON.stringify(inputs.composition))sourceKey=inputs.sourceKey;
    }catch{/* Retain preview access, never invent an approval for unknown inputs. */}
    // Media URLs must use the same tenant-aware presenter as ordinary assets.
    const { presentImageAsset }=await import("./image-studio-service");
    history.push({id:task.id,assetId:found.asset.id,mediaUrl:presentImageAsset(found.asset).url,sourceKey,status:"READY"});
  }
}

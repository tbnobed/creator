import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readFile,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {db,pool,productionProjectsTable,imageStudioAssetsTable} from "@workspace/db";
import {eq} from "drizzle-orm";
import {stateOf,saveProduction,productionLock} from "../lib/production-store";
import {mutateProductionAsset} from "../lib/production-assets";
import {mediaStorage} from "../lib/storage-service";
async function main(){
  const [source]=await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.id,"b256101d-8c9a-4314-976d-577c4f80fc9e"));
  if(!source)throw new Error("Verification source missing");
  const state=structuredClone(stateOf(source));
  const id=process.argv[2] || randomUUID();
  if(!process.argv[2]){
  const [prop]=await db.select().from(imageStudioAssetsTable).where(eq(imageStudioAssetsTable.id,state.propReference!.assetId));
  const dir=await mkdtemp(path.join(tmpdir(),"prop-crop-"));
  try {
    const file=path.join(dir,"ball.png");
    execFileSync("ffmpeg",["-v","error","-y","-i",mediaStorage.resolvePath(prop.storageKey),"-vf","crop=190:190:700:790","-frames:v","1",file]);
    const storageKey=await mediaStorage.storeImageStudioImage("Reviewed solid red wooden ball.png","image/png",await readFile(file),source.tenantId);
    const [asset]=await db.insert(imageStudioAssetsTable).values({tenantId:source.tenantId,createdByUserId:source.createdByUserId,name:"Reviewed red ball crop",mimeType:"image/png",storageKey,width:190,height:190}).returning();
    state.propReference={...state.propReference!,assetId:asset.id,approvedAssetId:asset.id,mediaUrl:`/api/media/${storageKey}`};
  }finally{await rm(dir,{recursive:true,force:true});}
  state.tasks=[];state.step=4;
  for(const scene of state.story.scenes){scene.shots=scene.shots?.slice(0,1);scene.durationSeconds=5;delete scene.opening;}
  await db.insert(productionProjectsTable).values({id,tenantId:source.tenantId,createdByUserId:source.createdByUserId,title:"Continuity verification — reviewed scene compositions",state:state as unknown as Record<string,unknown>});
  }
  console.log("FIXTURE",id);
  for(const scene of state.story.scenes.filter(s=>!process.argv[3] || String(s.sceneNumber)===process.argv[3])) {
    await productionLock(id,async()=>{
      const [row]=await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.id,id));
      await saveProduction(row,await mutateProductionAsset(row,"generate-scene-opening",{sceneNumber:scene.sceneNumber,correction:process.argv[4]}));
    });
    let ready=false;
    for(let i=0;i<180;i++){
      const [row]=await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.id,id));
      const current=stateOf(row);
      const failed=current.tasks.find(t=>t.status==="FAILED");
      if(failed)throw new Error(failed.error);
      const opening=current.story.scenes.find(s=>s.sceneNumber===scene.sceneNumber)?.opening;
      if(opening?.status==="READY") {console.log("REVIEW",scene.sceneNumber,JSON.stringify(opening));ready=true;break;}
      await new Promise(r=>setTimeout(r,2000));
    }
    if(!ready)throw new Error("Opening timed out; inspect existing job rather than resubmitting.");
  }
  console.log("Openings generated; explicit visual review and approval still required.");
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());

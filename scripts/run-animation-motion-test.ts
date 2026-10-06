// Two bounded, separately inspected paid experiments. Fixed IDs prevent paid retries.
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { eq } from "../artifacts/api-server/node_modules/drizzle-orm/index.js";
import { db, pool, generationJobsTable } from "../lib/db/src";
import { mediaStorage } from "../artifacts/api-server/src/lib/storage-service";
import { prepareReplacementSource } from "../artifacts/api-server/src/lib/video-replacement-media";
import { createAndSubmitGeneration } from "../artifacts/api-server/src/lib/generation-service";
import { quoteVideoSpend } from "../artifacts/api-server/src/lib/spending-pricing";

const single = process.argv.includes("--single-monkey");
const jobId = single ? "a80634dc-04ac-45e4-987a-0b502aa3bced" : "15c7e05e-ecf7-4cc6-a0a6-aa4c16490bbb";
const folder = `attached_assets/monkey-motion-${single ? "single" : "unrestricted"}`;
const prompt = single
  ? "In @Video1, animate the large gray monkey printed at the center of the man's white shirt. At first its arms are raised; during seconds 1–2 lower both arms to its sides, during seconds 2–3 raise them overhead, and during seconds 3–5 wave one arm side to side twice. Make the change of pose obvious. This is a flat 2D cartoon animated inside the fabric print, never a three-dimensional creature. Keep its distressed gray ink texture, size and location. Its body and moving arms must bend with the cloth and inherit cloth shading and hand occlusion. Keep the other printed monkeys still. Keep the live-action man, his performance, shirt construction, background and camera as in the source. Only the gray monkey has NEW independent motion."
  : "In @Video1, bring the colored monkey drawings on the man's shirt to life as clearly moving flat 2D printed cartoons. They independently dance: lower their raised arms, lift them again, wave side to side, turn their heads and swing their tails. Start this new motion immediately and continue throughout the five seconds. Their poses must visibly change independently of the man's movement. The original video shows static artwork; CHANGE that artwork into animated characters. Keep their original colored distressed ink style. They remain flat ink on the cloth, deforming with folds, shadows and hand occlusion, never floating or becoming 3D. Keep the man's face, live-action body movement, shirt construction, camera and background unchanged.";
const getJob = async (id: string) => (await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, id)))[0];

async function main() {
  await mkdir(folder, { recursive: true });
  let job = await getJob(jobId);
  if (!job) {
    if (process.env.RUN_APPROVED_ANIMATION_TESTS !== "two-bounded-tests") throw new Error("Paid-test execution gate not supplied.");
    const source = await getJob("a0f5c762-bd61-4a52-b183-6e10c3417c2d");
    if (!source || source.status !== "COMPLETED" || !source.outputStorageKey || !source.createdByUserId) throw new Error("Approved source is unavailable.");
    const quote = await quoteVideoSpend("fal-ai/kling-video/o3/standard/video-to-video/edit", {duration:5,resolution:"720p"});
    if (quote.estimatedUsd > 1.01) throw new Error("Per-test allowance exceeded.");
    const bytes = await prepareReplacementSource(await mediaStorage.readBuffer(source.outputStorageKey), 0, 5, "kling-o3-edit");
    const key = await mediaStorage.storeGenerationReferenceMedia("video/mp4", bytes, source.tenantId);
    await writeFile(`${folder}/input.mp4`, bytes);
    await writeFile(`${folder}/request.json`, JSON.stringify({jobId,prompt,model:"kling-o3-edit",durationSeconds:5,localAllowanceUsd:quote.estimatedUsd,referenceImages:0},null,2));
    console.log(JSON.stringify({phase:"SUBMITTING_ONCE",jobId,localAllowanceUsd:quote.estimatedUsd}));
    await createAndSubmitGeneration({
      jobId, tenantId:source.tenantId, createdByUserId:source.createdByUserId,
      provider:"FAL", model:"kling-o3-edit", prompt, referenceVideoKeys:[key],
      generationMode:"replace-item", durationSeconds:5, fps:24, width:1280,height:720,
      outputResolution:"720p",outputFormat:"mp4",nativeAudioEnabled:false,qualityPreset:"STANDARD",seedMode:"RANDOM",
      videoReplacement:{fingerprint:createHash("sha256").update(prompt).digest("hex"),sourceStorageKey:key,preparedKey:key,target:single ? "Gray monkey independent arm motion" : "Printed monkeys independent animation",startSeconds:0,durationSeconds:5},
    });
  }
  let last = "";
  for (let i=0;i<120;i++) {
    job = await getJob(jobId);
    if (!job) throw new Error("No saved job. Stop; do not resubmit automatically.");
    if (job.status !== last) console.log(JSON.stringify({jobId,status:job.status,stage:job.currentNode}));
    last = job.status;
    if (job.status === "COMPLETED" && job.outputStorageKey) {
      await writeFile(`${folder}/output.mp4`, await mediaStorage.readBuffer(job.outputStorageKey));
      console.log(JSON.stringify({phase:"COMPLETE",folder}));
      return;
    }
    if (["FAILED","CANCELLED"].includes(job.status)) {
      console.log(JSON.stringify({phase:"STOPPED_NO_RETRY",status:job.status,error:job.errorMessage?.replace(/https?:\/\/[^\s"']+/g,"[URL]")}));
      return;
    }
    await new Promise(r=>setTimeout(r,10000));
  }
  console.log("MONITOR_WINDOW_ENDED; reuse this job, never create an automatic retry.");
}
main().catch(e=>{console.error("STOPPED_NO_RETRY:",String(e).replace(/https?:\/\/[^\s"']+/g,"[URL]"));process.exitCode=1;}).finally(()=>pool.end());

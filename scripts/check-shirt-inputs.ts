// Read/access checks only. This script never calls a generation endpoint.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "../artifacts/api-server/node_modules/drizzle-orm/index.js";
import { db, pool, generationJobsTable } from "../lib/db/src";
import { mediaStorage } from "../artifacts/api-server/src/lib/storage-service";
import { uploadFalStorageFile, verifyFalStorageRead } from "../artifacts/api-server/src/lib/fal/storage";
import { probeVideoMediaProperties } from "../artifacts/api-server/src/lib/video-media-probe";
import { normalizeFalRequest, validateFalReferenceMediaLimits } from "../artifacts/api-server/src/lib/fal/client";

async function main() {
  const [job] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, "73f9888d-d493-4a28-91ee-df05a3eb7285"));
  const meta = job.providerTaskMetadata.videoReplacement as {preparedKey:string};
  const video = (await mediaStorage.readGenerationReferenceMedia(meta.preparedKey)).bytes;
  const image = await readFile("attached_assets/Monkeys_1791306027820.png");
  const properties = await probeVideoMediaProperties(video);
  validateFalReferenceMediaLimits("seedance-2.5", { images: [{sizeBytes:image.length}], videos:[{sizeBytes:video.length,...properties}], audios:[] });
  console.log(JSON.stringify({mediaLimits:"passed",video:{...properties,sizeBytes:video.length},imageBytes:image.length}));
  for (const [name, bytes, mime] of [["source.mp4", video, "video/mp4"], ["shirt.png", image, "image/png"]] as const) {
    const url = await uploadFalStorageFile(bytes, mime, name, process.env.FAL_KEY!.trim());
    await verifyFalStorageRead(url);
    const response = await fetch(url, {signal:AbortSignal.timeout(60000)});
    const downloaded = Buffer.from(await response.arrayBuffer());
    const equal = createHash("sha256").update(bytes).digest("hex") === createHash("sha256").update(downloaded).digest("hex");
    const unsigned = new URL(url); unsigned.search = "";
    const denied = await fetch(unsigned, {method:"HEAD",signal:AbortSignal.timeout(20000)});
    console.log(JSON.stringify({file:name,signedReadStatus:response.status,bytesMatch:equal,unsignedReadStatus:denied.status}));
    if (!response.ok || !equal || denied.ok) throw new Error("Private media access test failed.");
  }
  const normalized = normalizeFalRequest("seedance-2.5", {
    prompt:job.compiledPrompt, durationSeconds:3, width:1280, height:720, fps:24,
    outputResolution:"720p", nativeAudioEnabled:false, seedanceTask:"editing",
  });
  // Print only non-sensitive scalar settings, never signed URLs or source data.
  console.log(JSON.stringify({settings:{...normalized.input,prompt:"[saved prompt]", task:"editing"},promptCharacters:job.compiledPrompt.length}));
}
main().catch(e=>{ console.error(e.message.replace(/https?:\/\/\S+/g,"[URL]"));process.exitCode=1; }).finally(()=>pool.end());

// One user-approved shirt replacement proof. No animation and no paid retry.
// Re-running this script monitors the same durable job rather than creating another.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { and, eq } from "../artifacts/api-server/node_modules/drizzle-orm/index.js";
import { db, pool, generationJobsTable, tenantMembershipsTable, tenantsTable, usersTable } from "../lib/db/src";
import { quoteVideoSpend } from "../artifacts/api-server/src/lib/spending-pricing";
import { mediaStorage } from "../artifacts/api-server/src/lib/storage-service";
import { submitPaidReplacement } from "../artifacts/api-server/src/lib/video-replacement-service";

const hostedRetest = process.argv.includes("--hosted-retest");
const durationRetest = process.argv.includes("--duration-retest");
const durationSeconds = durationRetest ? 5 : 3;
const jobId = durationRetest ? "7a805c6d-2d3d-4624-95ba-d4227cbd925a" : hostedRetest
  ? "b6d23acb-56c9-425d-8123-e96398db9fd4"
  : "73f9888d-d493-4a28-91ee-df05a3eb7285";
const folder = durationRetest ? "attached_assets/shirt-replacement-duration-retest" : hostedRetest
  ? "attached_assets/shirt-replacement-hosted-retest"
  : "attached_assets/shirt-replacement-proof";
const existing = async () => (await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, jobId)))[0];

async function main() {
  await mkdir(folder, { recursive: true });
  let job = await existing();
  if (!job) {
    if (process.env.RUN_APPROVED_SHIRT_TEST !== "one-approved-submission") {
      throw new Error("Explicit one-submission execution flag is required.");
    }
    const owners = await db.select({ userId: usersTable.id, tenantId: tenantsTable.id })
      .from(usersTable)
      .innerJoin(tenantsTable, and(eq(usersTable.activeTenantId, tenantsTable.id), eq(tenantsTable.isDefault, true)))
      .innerJoin(tenantMembershipsTable, and(eq(tenantMembershipsTable.userId, usersTable.id),
        eq(tenantMembershipsTable.tenantId, tenantsTable.id), eq(tenantMembershipsTable.role, "OWNER")))
      .where(eq(usersTable.siteRole, "SITE_ADMIN"));
    if (owners.length !== 1) throw new Error("Cannot unambiguously resolve the operator workspace.");
    const owner = owners[0];
    const quote = await quoteVideoSpend("bytedance/seedance-2.5/reference-to-video", {
      duration: 30, resolution: "720p", width: 1800, height: 720,
      referenceVideoDuration: durationSeconds, referenceImageCount: 1, audio: false,
    });
    if (quote.estimatedUsd > 15) throw new Error("Local estimate exceeds the approved $15 allowance.");
    console.log(JSON.stringify({ phase: "preflight", localReservationUsd: quote.estimatedUsd, maxApprovedLocalEstimateUsd: 15 }));
    const sourceStorageKey = await mediaStorage.storeGenerationReferenceMedia(
      "video/quicktime", await readFile("attached_assets/Orange_shirt_1791306138579.mov"), owner.tenantId,
    );
    const referenceStorageKey = await mediaStorage.storeGenerationReferenceMedia(
      "image/png", await readFile("attached_assets/Monkeys_1791306027820.png"), owner.tenantId,
    );
    const result = await submitPaidReplacement({
      ...owner, requestId: jobId, provider: "FAL", model: "seedance-2.5", confirmPaid: true,
      sourceStorageKey, referenceStorageKey, mode: "replace-item",
      targetGarment: "Only the black polo shirt worn by the seated man with glasses",
      prompt: `Replace his black polo with the white short-sleeved button-up shirt in the reference image. Match its collar, button placket, pocket and large distressed monkey print in mustard yellow, rust orange, olive and gray. Fit naturally to his seated body, with realistic cloth folds, shadows and hand occlusion. The monkeys remain static printed artwork in this first pass. Preserve his face, glasses, hair, skin, hands, trousers, chair, background and performance. Keep the same shot and approximately ${durationRetest ? "five" : "three"}-second timing.`,
      startSeconds: 2, durationSeconds, seed: 1791306027,
    });
    await writeFile(`${folder}/receipt.json`, JSON.stringify({
      jobId: result.jobId, model: "seedance-2.5", phase: "shirt replacement only",
      sourceWindow: { startSeconds: 2, durationSeconds },
      localReservationUsd: quote.estimatedUsd, maxApprovedLocalEstimateUsd: 15,
    }, null, 2));
  }
  let previous = "";
  for (let attempt = 0; attempt < 120; attempt++) {
    job = await existing();
    if (!job) throw new Error("No durable job was saved; stop without retrying.");
    const state = JSON.stringify({ jobId, status: job.status, stage: job.currentNode });
    if (state !== previous) { console.log(state); previous = state; }
    if (job.status === "COMPLETED" && job.outputStorageKey) {
      const output = `${folder}/shirt-replacement.mp4`;
      await writeFile(output, await mediaStorage.readBuffer(job.outputStorageKey));
      const replacement = job.providerTaskMetadata.videoReplacement as { preparedKey: string };
      await writeFile(`${folder}/original-window.mp4`, (await mediaStorage.readGenerationReferenceMedia(replacement.preparedKey)).bytes);
      console.log(JSON.stringify({ phase: "COMPLETE", output }));
      return;
    }
    if (["FAILED", "CANCELLED"].includes(job.status)) {
      console.log(JSON.stringify({
        phase: "STOPPED_NO_RETRY", status: job.status,
        error: job.errorMessage?.replace(/https?:\/\/[^\s"']+/g, "[provider URL]"),
        providerAccepted: Boolean(job.providerRequestId),
      }));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  console.log("MONITOR_WINDOW_ENDED: job remains durable; do not submit a replacement request.");
}
main().catch(error => {
  console.error("STOPPED_NO_RETRY:", error instanceof Error ? error.message.replace(/https?:\/\/[^\s\"']+/g, "[URL]") : "Request failed");
  process.exitCode = 1;
}).finally(async () => { await pool.end(); });

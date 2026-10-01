import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  comfyServersTable, db, generationJobsTable, imageStudioJobsTable,
  longFormProjectsTable, longFormShotsTable, pool, tenantsTable, usersTable,
  videoLibraryStatesTable, workflowTemplatesTable,
} from "@workspace/db";
import serversRouter from "../routes/servers";
import generationsRouter from "../routes/generations";
import { requireSiteAdmin } from "../middlewares/auth";
import { selectServer } from "./comfy/scheduler";
import { createAndSubmitGeneration } from "./generation-service";
import {
  comfyServerLockKey, getAssignableWorker, softDeleteWorker,
} from "./worker-lifecycle";

// Invoke real route handlers without starting an application or contacting a
// GPU/provider. Fixtures use a reserved .invalid hostname and are disabled.
type Handler = (req: Request, res: Response) => Promise<void>;
type Routes = { stack: Array<{ route?: {
  path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }>;
} }> };
function response() {
  return {
    statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    sendStatus(code: number) { this.statusCode = code; return this; },
  };
}

test("worker tombstones preserve history, enforce live routes and serialize claims", {
  skip: process.env.RUN_WORKER_DELETION_DB_TESTS !== "true"
    ? "set RUN_WORKER_DELETION_DB_TESTS=true against development" : false,
}, async (t) => {
  assert.equal(process.env.NODE_ENV, "development", "Development fixtures only");
  assert.ok(process.env.REPLIT_DEV_DOMAIN, "Must run in the development workspace");
  const userId = `worker-delete-test-${randomUUID()}`;
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const workerIds: string[] = [];
  const workflowIds: string[] = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Worker deletion tests must not call providers/GPU endpoints"); };
  const [user] = await db.insert(usersTable).values({ id: userId, displayName: "Worker deletion fixture", siteRole: "SITE_ADMIN" }).returning();
  try {
    const [tenant] = await db.insert(tenantsTable).values({
      id: tenantId, name: "Worker deletion fixture", slug: `worker-delete-${tenantId}`,
    }).returning();
    await db.insert(longFormProjectsTable).values({
      id: projectId, tenantId, createdByUserId: userId, title: "Never rendered fixture",
      script: "", targetDurationSeconds: 5, generationMode: "TEST", width: 512,
      height: 512, fps: 24, qualityPreset: "TEST",
    });
    async function route(method: string, path: string, id?: string, body?: unknown) {
      const router = path.startsWith("/dashboard") ? generationsRouter : serversRouter;
      const layer = (router as unknown as Routes).stack.find((entry) =>
        entry.route?.path === path && entry.route.methods[method]);
      assert.ok(layer?.route, `Missing ${method} ${path}`);
      const req = { params: id ? { id } : {}, body, context: { user, tenant, membership: null } } as Request;
      const res = response();
      await layer.route.stack[0].handle(req, res as unknown as Response);
      return res;
    }
    async function worker() {
      const id = randomUUID();
      workerIds.push(id);
      const [row] = await db.insert(comfyServersTable).values({
        id, displayName: `Deletion fixture ${id}`, hostname: "worker-delete.invalid",
        apiBaseUrl: "http://worker-delete.invalid:8188", websocketUrl: "ws://worker-delete.invalid:8188/ws",
        enabled: false, status: "ONLINE", activeJobCount: 999, queueSize: 999,
        tags: ["flux2-klein"],
      }).returning();
      return row;
    }
    async function generation(workerId: string, status = "COMPLETED") {
      const [row] = await db.insert(generationJobsTable).values({
        tenantId, createdByUserId: userId, title: "Never submitted fixture", prompt: "fixture",
        compiledPrompt: "fixture", width: 512, height: 512, fps: 24, frameCount: 120,
        durationSeconds: 5, generationMode: "TEST", qualityPreset: "TEST", status,
        comfyServerId: workerId, providerTaskMetadata: { workerDeletionFixture: true },
      }).returning();
      return row;
    }
    async function image(workerId: string) {
      const [row] = await db.insert(imageStudioJobsTable).values({
        tenantId, createdByUserId: userId, modelId: "fixture", modelName: "Never submitted",
        provider: "LOCAL", operation: "generate", prompt: "fixture", width: 512, height: 512,
        count: 1, status: "COMPLETED", comfyServerId: workerId,
      }).returning();
      return row;
    }
    let shotNumber = 0;
    async function shot(workerId: string, status = "COMPLETED", jobId?: string) {
      const [row] = await db.insert(longFormShotsTable).values({
        projectId, sceneNumber: 1, shotNumber: ++shotNumber, title: "Never rendered",
        prompt: "fixture", durationSeconds: 5, status, assignedServerId: workerId, generationJobId: jobId,
      }).returning();
      return row;
    }
    async function snapshot(workerId: string) {
      return Promise.all([
        db.select().from(generationJobsTable).where(eq(generationJobsTable.comfyServerId, workerId)).orderBy(generationJobsTable.id),
        db.select().from(imageStudioJobsTable).where(eq(imageStudioJobsTable.comfyServerId, workerId)).orderBy(imageStudioJobsTable.id),
        db.select().from(longFormShotsTable).where(eq(longFormShotsTable.assignedServerId, workerId)).orderBy(longFormShotsTable.id),
        db.select().from(videoLibraryStatesTable).where(eq(videoLibraryStatesTable.tenantId, tenantId)).orderBy(videoLibraryStatesTable.id),
      ]);
    }
    await t.test("terminal and non-active history survives with every FK and worker attribution intact", async () => {
      const server = await worker();
      const job = await generation(server.id);
      for (const status of ["DRAFT", "FAILED", "CANCELLED"]) await generation(server.id, status);
      await image(server.id);
      const failedImage = await image(server.id);
      const cancelledImage = await image(server.id);
      await db.update(imageStudioJobsTable).set({ status: "FAILED" }).where(eq(imageStudioJobsTable.id, failedImage.id));
      await db.update(imageStudioJobsTable).set({ status: "CANCELLED" }).where(eq(imageStudioJobsTable.id, cancelledImage.id));
      for (const status of ["COMPLETED", "PLANNED", "FAILED", "CANCELLED"]) await shot(server.id, status, job.id);
      await db.insert(videoLibraryStatesTable).values({ tenantId, generationJobId: job.id, favorite: true });
      const before = await snapshot(server.id);
      const removed = await route("delete", "/servers/:id", server.id);
      assert.equal(removed.statusCode, 204);
      const [tombstone] = await db.select().from(comfyServersTable).where(eq(comfyServersTable.id, server.id));
      assert.ok(tombstone.deletedAt);
      assert.equal(tombstone.enabled, false);
      assert.equal(tombstone.displayName, server.displayName);
      assert.deepEqual(await snapshot(server.id), before, "Deletion must not rewrite or remove linked history");
      const names = await db.select({ name: comfyServersTable.displayName }).from(generationJobsTable)
        .innerJoin(comfyServersTable, eq(generationJobsTable.comfyServerId, comfyServersTable.id))
        .where(eq(generationJobsTable.id, job.id));
      assert.equal(names[0].name, server.displayName);
      assert.equal((await route("delete", "/servers/:id", server.id)).statusCode, 404);
      assert.equal((await route("delete", "/servers/:id", randomUUID())).statusCode, 404);
    });
    await t.test("only genuinely active assigned generation, image and shot statuses block deletion", async () => {
      const server = await worker();
      const job = await generation(server.id);
      const imageJob = await image(server.id);
      const longShot = await shot(server.id);
      for (const status of ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"]) {
        await db.update(generationJobsTable).set({ status }).where(eq(generationJobsTable.id, job.id));
        assert.equal((await route("delete", "/servers/:id", server.id)).statusCode, 409, status);
      }
      await db.update(generationJobsTable).set({ status: "COMPLETED" }).where(eq(generationJobsTable.id, job.id));
      for (const status of ["QUEUED", "RUNNING"] as const) {
        await db.update(imageStudioJobsTable).set({ status }).where(eq(imageStudioJobsTable.id, imageJob.id));
        assert.equal((await route("delete", "/servers/:id", server.id)).statusCode, 409, status);
      }
      await db.update(imageStudioJobsTable).set({ status: "COMPLETED" }).where(eq(imageStudioJobsTable.id, imageJob.id));
      for (const status of ["QUEUED", "RENDERING"]) {
        await db.update(longFormShotsTable).set({ status }).where(eq(longFormShotsTable.id, longShot.id));
        assert.equal((await route("delete", "/servers/:id", server.id)).statusCode, 409, status);
      }
      await db.update(longFormShotsTable).set({ status: "COMPLETED" }).where(eq(longFormShotsTable.id, longShot.id));
      // Active work assigned elsewhere or unassigned must not block this worker.
      await db.update(generationJobsTable).set({ status: "RUNNING", comfyServerId: null }).where(eq(generationJobsTable.id, job.id));
      assert.equal((await route("delete", "/servers/:id", server.id)).statusCode, 204);
    });
    await t.test("tombstones are absent from operational routes, dashboard and selectors, even if re-enabled externally", async () => {
      const server = await worker();
      assert.equal(await getAssignableWorker(server.id), undefined, "Disabled worker cannot be claimed");
      assert.equal((await route("delete", "/servers/:id", server.id)).statusCode, 204);
      const summaryBefore = (await route("get", "/dashboard/summary")).body as { onlineServerCount: number };
      await db.update(comfyServersTable).set({ enabled: true, status: "ONLINE", activeJobCount: 0 }).where(eq(comfyServersTable.id, server.id));
      const list = (await route("get", "/servers")).body as Array<{ id: string }>;
      assert.ok(!list.some((row) => row.id === server.id));
      for (const [method, path, body] of [
        ["get", "/servers/:id/configuration", undefined],
        ["get", "/servers/:id/queue", undefined],
        ["post", "/servers/:id/test", undefined],
        ["patch", "/servers/:id", { enabled: true, displayName: "Must not update" }],
      ] as const) {
        assert.equal((await route(method, path, server.id, body)).statusCode, 404, path);
      }
      assert.equal(((await route("get", "/dashboard/summary")).body as { onlineServerCount: number }).onlineServerCount, summaryBefore.onlineServerCount);
      assert.equal(await getAssignableWorker(server.id), undefined);
      const [deleted] = await db.select().from(comfyServersTable).where(eq(comfyServersTable.id, server.id));
      assert.equal(selectServer([deleted], ["flux2-klein"]), null);
      assert.equal(deleted.displayName, server.displayName, "PATCH cannot mutate a tombstone");
      const res = response();
      requireSiteAdmin({ context: { user: { siteRole: "USER" } } } as Request, res as unknown as Response, () => assert.fail("Unauthorized worker access"));
      assert.equal(res.statusCode, 403);
    });
    await t.test("claim wins: DELETE waits on the common lock and then sees committed active work", async () => {
      const server = await worker();
      const job = await generation(server.id, "DRAFT");
      await db.update(comfyServersTable).set({ enabled: true, activeJobCount: 0 }).where(eq(comfyServersTable.id, server.id));
      const claim = await pool.connect();
      let deleting: Promise<"deleted" | "missing" | "active"> | undefined;
      try {
        await claim.query("SELECT pg_advisory_lock(hashtext($1))", [comfyServerLockKey(server.id)]);
        assert.ok(await getAssignableWorker(server.id));
        deleting = softDeleteWorker(server.id);
        const pid = (await claim.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          waiting = (await pool.query<{ waiting: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting", [pid],
          )).rows[0].waiting;
          if (!waiting) await delay(10);
        }
        assert.ok(waiting, "DELETE must wait on the exact assignment lock");
        await claim.query("UPDATE obtv_generation_jobs SET status='UPLOADING' WHERE id=$1", [job.id]);
      } finally {
        await claim.query("SELECT pg_advisory_unlock(hashtext($1))", [comfyServerLockKey(server.id)]);
        claim.release();
      }
      assert.equal(await deleting, "active");
      await db.update(generationJobsTable).set({ status: "CANCELLED" }).where(eq(generationJobsTable.id, job.id));
      assert.equal(await softDeleteWorker(server.id), "deleted");
    });
    await t.test("delete wins: a candidate selected before deletion is revalidated after the claim lock", async () => {
      const server = await worker();
      await db.update(comfyServersTable).set({ enabled: true, activeJobCount: 0 }).where(eq(comfyServersTable.id, server.id));
      assert.ok(await getAssignableWorker(server.id), "Candidate selected before DELETE");
      assert.equal(await softDeleteWorker(server.id), "deleted");
      const claim = await pool.connect();
      try {
        const result = await claim.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [comfyServerLockKey(server.id)]);
        assert.equal(result.rows[0].locked, true);
        assert.equal(await getAssignableWorker(server.id), undefined, "Stale candidate must never record a job/shot claim");
      } finally {
        await claim.query("SELECT pg_advisory_unlock(hashtext($1))", [comfyServerLockKey(server.id)]);
        claim.release();
      }
      assert.equal((await db.select().from(generationJobsTable).where(eq(generationJobsTable.comfyServerId, server.id))).length, 0);
    });
    await t.test("the real generation submission rejects its stale worker snapshot before recording a job", async () => {
      const server = await worker();
      const mode = `worker-deletion-race-${randomUUID()}`;
      const workflowId = randomUUID();
      workflowIds.push(workflowId);
      await db.insert(workflowTemplatesTable).values({
        id: workflowId, name: "Never submitted race fixture", generationMode: mode,
        modelFamily: "TEST", active: true, compatibleServerTags: [mode],
        apiWorkflow: { "1": { class_type: "TestFixtureNeverSubmitted", inputs: {} } },
      });
      await db.update(comfyServersTable).set({ enabled: true, activeJobCount: 0, tags: [mode] })
        .where(eq(comfyServersTable.id, server.id));
      const queryBefore = pool.query;
      let deletedAfterSelection = false;
      // Simulate DELETE committing after the real candidate SELECT has read
      // its rows but before the real submission acquires its worker lock.
      pool.query = new Proxy(queryBefore, {
        apply(target, receiver, args) {
          const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
          const result = Reflect.apply(target, receiver, args);
          if (!deletedAfterSelection && typeof text === "string"
            && text.startsWith("select ") && text.includes('from "obtv_comfy_servers"')) {
            deletedAfterSelection = true;
            return result.then(async (rows: unknown) => {
              assert.equal(await softDeleteWorker(server.id), "deleted");
              return rows;
            });
          }
          return result;
        },
      });
      try {
        await assert.rejects(createAndSubmitGeneration({
          tenantId, createdByUserId: userId, prompt: "Never submitted fixture", generationMode: mode,
          durationSeconds: 5, fps: 24, width: 512, height: 512, qualityPreset: "TEST", seedMode: "RANDOM",
        }), /worker is no longer available/);
        assert.equal(deletedAfterSelection, true);
      } finally {
        pool.query = queryBefore;
      }
      assert.equal((await db.select().from(generationJobsTable).where(eq(generationJobsTable.comfyServerId, server.id))).length, 0);
    });
  } finally {
    globalThis.fetch = fetchBefore;
    // Delete exclusively this run's fixtures, in FK-safe order. No user data.
    await db.delete(longFormShotsTable).where(eq(longFormShotsTable.projectId, projectId));
    await db.delete(longFormProjectsTable).where(eq(longFormProjectsTable.id, projectId));
    await db.delete(imageStudioJobsTable).where(eq(imageStudioJobsTable.tenantId, tenantId));
    await db.delete(generationJobsTable).where(and(eq(generationJobsTable.tenantId, tenantId), eq(generationJobsTable.createdByUserId, userId)));
    if (workerIds.length) await db.delete(comfyServersTable).where(inArray(comfyServersTable.id, workerIds));
    if (workflowIds.length) await db.delete(workflowTemplatesTable).where(inArray(workflowTemplatesTable.id, workflowIds));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await pool.end();
  }
});
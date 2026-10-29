import test from "node:test";
import assert from "node:assert/strict";
import { prepareProductionRerenders } from "./production-rerender";
import { shotMutationDispatch } from "./long-form-service";

test("deferred edits and retries stay paused; normal standalone mutations retain automatic dispatch", () => {
  assert.deepEqual(shotMutationDispatch(false), { status: "RUNNING", shouldSchedule: true });
  for (const continuityRevision of [false, true]) {
    assert.deepEqual(shotMutationDispatch(continuityRevision, true), { status: "PAUSED", shouldSchedule: false });
  }
  assert.deepEqual(shotMutationDispatch(true), { status: "PAUSED", shouldSchedule: false });
});

test("completed, failed, cancelled and planned shot changes finish before a single dispatch", async () => {
  const events: string[] = [];
  let schedulerOwnsLock = false;
  let submissions = 0;
  const updates = ["COMPLETED", "FAILED", "CANCELLED", "PLANNED"].map(status => ({
    shot: { id: status, status }, prompt: `Unchanged ${status} prompt`,
  }));
  await prepareProductionRerenders("project", updates, {
    pause: async (id, options) => {
      assert.equal(id, "project");
      assert.equal(options.forCorrection, true);
      events.push("pause");
    },
    update: async (id, shotId, input, options) => {
      assert.equal(id, "project");
      assert.equal(input.prompt, `Unchanged ${shotId} prompt`);
      assert.equal(schedulerOwnsLock, false, "background dispatch must not interrupt later mutations");
      const dispatch = shotMutationDispatch(false, options.deferStart);
      assert.equal(dispatch.status, "PAUSED");
      schedulerOwnsLock = dispatch.shouldSchedule;
      events.push(`update:${shotId}`);
    },
    retry: async (id, shotId, options) => {
      assert.equal(id, "project");
      assert.equal(schedulerOwnsLock, false);
      schedulerOwnsLock = shotMutationDispatch(false, options.deferStart).shouldSchedule;
      events.push(`retry:${shotId}`);
    },
    start: async () => {
      assert.equal(schedulerOwnsLock, false, "Start must not collide with a renderer already scheduled by this request");
      schedulerOwnsLock = true;
      submissions++;
      events.push("start");
    },
  });
  assert.equal(submissions, 1);
  assert.deepEqual(events, [
    "pause", "update:COMPLETED", "update:FAILED", "retry:FAILED",
    "update:CANCELLED", "retry:CANCELLED", "update:PLANNED", "start",
  ]);
});

test("real preparation and Start failures are not hidden or automatically resubmitted", async () => {
  const updates = [{ shot: { id: "shot", status: "FAILED" }, prompt: "Keep the same prompt" }];
  for (const failure of ["update", "retry", "start"]) {
    let starts = 0;
    const fail = async (step: string) => {
      if (step === failure) throw new Error(`Real ${step} failure`);
    };
    await assert.rejects(prepareProductionRerenders("project", updates, {
      pause: async () => {},
      update: async () => fail("update"),
      retry: async () => fail("retry"),
      start: async () => { starts++; await fail("start"); },
    }), new RegExp(`Real ${failure} failure`));
    assert.equal(starts, failure === "start" ? 1 : 0);
  }
});

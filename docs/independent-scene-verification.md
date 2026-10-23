# Independent scene dispatch verification

Verified in development on 2026-10-23 with real ComfyUI submissions, not queue mocks.

## Visible fixture

Production: **Parallel GPU Verification — Two Independent Scenes**

Route: `/productions/92215a05-3e1b-476f-a3e0-e8cafd2036ea`

This is a separate four-shot copy of the existing reviewed two-scene fixture.
The source production was not changed. The copy uses locked cast and scenery;
unapproved wardrobe drafts were excluded rather than approved by the test.
No worker registrations, concurrency limits, MIG assignments, or Cloud jobs
were changed.

## Observed evidence

- Both opening shots were RENDERING while both continuations remained PLANNED.
- RTX 5090 8192: scene 1 prompt `375980dd-fc05-49b6-8f40-96442649fd01`.
- RTX 5090 8191: scene 2 prompt `42846a0e-bf6b-4e7c-a7ca-9a4497f130d7`.
- Direct `/queue` checks found each prompt in its own worker's running queue,
  with one running and zero pending jobs per worker.
- Pausing preserved both generation IDs and did not submit continuations;
  resuming preserved the active jobs.
- Scene 1's opening completed at `16:52:58.220Z`. Its continuation was claimed
  at `16:52:58.275Z` and subsequently reached RUNNING with two reference images.
  Scene 2's opening was still RUNNING; its continuation was still PLANNED.
- A real HTTPS login with a temporary test member loaded the production Create
  page and expanded both scene rows without browser exceptions.
  Screenshot: `generated-artifacts/parallel-scenes-queue.png` (ignored output).

The live fixture is retained to finish rendering and remain inspectable.
Final assembly completion was not required to prove parallel dispatch and was
not claimed by this verification.

## Repeatable checks

- `pnpm --filter @workspace/api-server typecheck` — passed.
- Frontend-local `tsx --test artifacts/api-server/src/lib/production-dispatch.test.ts`
  — all five tests passed, including scene-scoped failure, missing output,
  unsorted input, and same-scene predecessor cases.
- Broader `production-*.test.ts` run — 22 passed, two unrelated scenery-control
  tests failed because fixture ID `p` reaches PostgreSQL's UUID validation.
- `scripts/verify-independent-scenes.ts` is an opt-in real GPU test, run from
  `artifacts/api-server` with the frontend-local tsx runner and a reviewed
  two-scene source production ID. It creates a named copy, verifies real queues
  and pause/resume, and keeps submission monitors alive until four outputs finish.
- `node scripts/verify-production-live-ui.mjs <production-id> queue` verifies
  the authenticated queue UI without mocked routes or an authentication bypass.

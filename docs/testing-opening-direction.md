# Authenticated opening direction regression

Run against the **development HTTPS preview**, with the existing web and API
workflows running:

```sh
artifacts/obtv-video-studio/node_modules/.bin/tsx scripts/test-opening-direction.mts
```

The runner uses the workspace `DATABASE_URL` and `REPLIT_DEV_DOMAIN`. Chromium
defaults to `/repl/tools/bin/chromium`; another installed browser can be selected
with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

It provisions an isolated ordinary `USER` account and its own tenant, then signs
in through the visible email/password form. Cookies come only from normal HTTPS
login. It does not forge sessions, bypass authentication, mock API responses, or
touch existing users' projects. All fixture records are removed in `finally`.

## Assertions

- Selected portrait is used rather than the first, unselected option; the image
  actually loads in the browser.
- Cancel closes the review without a mutation request or database change.
- Confirm replaces the first-shot direction, preserves dialogue and story action,
  invalidates old approval, and queues the requested three versions.
- Versions appear in the UI; the saved direction is shown after reload.
- Queued work disables generation controls, and a queue created after opening a
  review rejects a changed direction at the API.
- Two real tabs cannot overwrite a newer direction with a stale review.
- Rejected requests show the error and retain the draft. A database-lock conflict
  does not mutate the project, and confirming again after release succeeds.
- Approved wardrobe supersedes the portrait in the rendered preview. Correction
  text and reviewed direction reach the API; the shared dispatch input builder,
  using that persisted state, selects approved references rather than the prior
  opening or an unselected portrait.

## Scope and safety

Reference previews use distinct local SVG data images. Their asset UUIDs are
deliberately absent from the media table, so media validation prevents GPU/provider
submission. The test asserts no image jobs were created. This verifies reference
**selection**, not photographic identity or rendered output quality.

Queue fixtures use real actions and the real background runtime. A project-only
advisory lock holds the queue during reload assertions; the test then clears its
own fixture tasks to reopen the persisted direction without waiting for a render.
The same-scene concurrency check must reach the API before the runtime fails its
deliberately missing media. A slow/contended preview can fail this check rather
than silently report success.

The authenticated review screenshot is saved under
`generated-artifacts/opening-direction/signed-in-review.png` (ignored by Git).
The platform screenshot browser is independently signed out; it is not evidence
of authenticated interactions.

Typecheck the standalone runner:

```sh
pnpm exec tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext \
  --target es2022 scripts/test-opening-direction.mts
```

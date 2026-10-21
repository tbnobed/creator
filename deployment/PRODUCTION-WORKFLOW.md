# Guided Long-Form productions

New projects start at `/projects/new` and resume at `/productions/:id`.
Existing render projects keep their `/projects/:id` editor.

## Deployment

Back up the database, update the source, then rebuild **both API and web**:

```sh
docker compose up -d --build api web
```

The API startup applies migration `0020_bright_giant_girl.sql`, adding the
production workflow table without changing existing project data. PDF imports
use `pdftotext`, now installed in the API image.

## Models and credentials

- Story: dedicated GPU `STORY_AI_BASE_URL` / `STORY_AI_MODEL`, or a paid
  OpenAI-compatible model. For standalone deployment, configure `OPENAI_API_KEY`
  and optionally `OPENAI_BASE_URL` (default `https://api.openai.com/v1`).
  The model-id field supports provider-qualified IDs when the configured
  compatible endpoint requires them. No credential is sent to the browser.
- The existing `PROMPT_AI_BASE_URL` / `PROMPT_AI_MODEL` remain CPU prompt
  assistance only. They are never used as a fallback for script writing.
- Set `STORY_AI_BASE_URL` to the GB10's private Ollama endpoint and
  `STORY_AI_MODEL` to an installed model (current migration baseline:
  `qwen2.5:1.5b`). The writer warms the selected model, checks `/api/ps`
  for nonzero GPU residency, then submits story content. CPU-only runners
  are refused. Models are unloaded after a stage to release residency;
  this does not itself coordinate ComfyUI capacity. Reserve capacity on the
  GPU host before enabling the endpoint.
- Ollama has no built-in authentication here: do **not** expose port 11434
  to the public internet. Verify connectivity from the actual API host over
  the private network or an authenticated tunnel. An app-side source update
  does not install or enable the service on the GB10.
- Images: the Image Studio catalog, including local and configured paid models.
  Reference sheets, wardrobe and location variants require native reference
  editing support. Models without seed support omit the seed instead of
  claiming deterministic generation.
- Video: existing local workflow capabilities or supported Fal video models.
  Paid images and videos use the existing `FAL_KEY` and spending-policy path.
- Paid actions require explicit confirmation. Portraits and reference sheets
  generate **four images per batch**. Story drafting makes an outline call
  followed by a call for each scene. Video batches charge per shot.

## Operational constraints

Local sequential video workflows need an explicit `firstFrame` parameter
mapping as well as enough independent reference slots for every locked
character, active outfit and location. Merely accepting reference images does
not prove that a workflow accepts an initial video frame. Unsupported modes
fail explicitly; references must not be silently dropped.

Cloud models must support the combination of a start frame and locked image
references. Provider duration, dimensions and reference limits still apply.
Selecting 10/30/90 minutes is a screenplay target, not a promise of exact output
length. Review the generated shot plan; individual shots remain limited to
30 seconds, with model-specific restrictions enforced at submission.

Production drafts are persisted with optimistic revisions. Background story
and image jobs resume from saved tasks. Existing provider receipt recovery and
the video orchestrator retain responsibility for accepted GPU/cloud jobs.

The continuity checker is an explicit **not implemented** adapter. The UI says
“Continuity: not checked”; an empty issue list is not a visual-quality verdict.
Export uses the existing FFmpeg assembly service.

## Verification boundary

Type checks, mocked browser workflow tests, and backend contract tests do not
qualify live model quality, sustained 90-minute rendering, or GPU capacity.
Run an explicitly approved short end-to-end pilot before production rollout.

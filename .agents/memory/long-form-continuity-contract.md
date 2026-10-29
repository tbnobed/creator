---
name: Long-form continuity contract
description: Approval and model-capability boundaries for long-form character continuity.
---

Treat an approved shot still and assigned wardrobe imagery as required render inputs, not optional prompt suggestions. Canonical character references may use remaining capacity; required imagery must not be silently discarded.

**Why:** A workflow can accept one reference yet lack space for wardrobe references. Advertising continuity in that case would hide that a creator's approved constraint never reached the model.

**How to apply:** Check the selected workflow's actual reference capacity before dispatch. Preserve per-job reference and speaker snapshots rather than relying on mutable project settings or shared state between GPUs.

Revising a completed continuity-controlled shot must leave time for review before rendering again.

**Why:** The ordinary edit-and-regenerate flow conflicts with a required still-approval stage. Continuity revisions need a deliberate paused review state, while existing projects without continuity retain their original behavior.

**How to apply:** Keep destructive revision actions explicit, preserve unrelated completed shots, and require a current approval before resuming. Voice cloning remains a separate explicit per-shot opt-in.

Reusable character dossiers are a source for explicitly imported production settings, not live-linked replacements for project continuity.

**Why:** Updating a cast-library wardrobe must not unexpectedly change an ongoing production's approved look. Dossier approval is advisory for legacy character use, separate from shot-still approval.

**How to apply:** Import approved dossier data only by producer action, confirm replacements, and retain project-owned snapshots. Describe text-only reference generation honestly; a saved primary image does not mean every image workflow consumes it.

The user requires exact starting-frame continuation, not the previous frame supplied merely as a visual reference.

**Why:** The user explicitly chose exact first-frame continuation when H3 REF2VA could not provide it.

**How to apply:** Do not alias H3 reference images as first frames. A workflow must consume a true starting-frame input without displacing mandatory cast/scenery references; otherwise it needs an approved composed-frame stage before animation.

Do not silently brighten or replace the continuation frame to hide cumulative exposure drift.

**Why:** The creator reported progressively darkening shots, but exact first-frame continuity remains an explicit requirement. Automatic grading of the handed-off image would change that contract rather than prove a lighting fix.

**How to apply:** Keep the approved scene lighting as the baseline. Detect severe unintended drift and request correction before propagating it; distinguish those guardrails from a verified model-level cure and preserve intentional lighting changes.

When the user requests Long-Form verification, test a visible application project through its actual steps, not only a direct ComfyUI submission.

**Why:** The user repeatedly requested end-to-end verification and rejected a standalone worker diagnostic as evidence that their project works.

**How to apply:** Keep worker diagnostics explicitly separate. Verify story drafting, saved project assets, render submission, continuation, review and export through the application; report the first blocked step without claiming completion.

Long-Form end-to-end verification must include multiple scenes, not just multiple shots in a single scene.

**Why:** The user explicitly required multiple scenes when the initial verification project had only one.

**How to apply:** Include distinct locations and carry cast/wardrobe across them; inspect within-scene continuation, scene transitions and final assembly.

Individual shots must be playable beside their correction controls; the assembled Review video is not a substitute.

**Why:** The user repeatedly requested shot previews to decide corrections, not instructions to watch the whole export.

**How to apply:** Keep shot playback accessible in both Create and manual Review corrections, without triggering a new render.

Project-content removal must not delete shared-library assets or historical rendered media. Structural edits require a fresh render plan.

**Why:** The user needs to edit and remove scenes, characters, wardrobe and places without destroying reusable assets or making old shot mappings appear current.

**How to apply:** Update dependencies and scene ranges, retain prior renders in history, and block changes while image generation or individual shots are still active.

Native H3 guide conditioning is not proof of exact first-frame preservation or cross-scene visual continuity.

**Why:** Live multi-scene verification produced playable exports but changed clothing, prop scale and appearance; decoded adjacent boundary frames were not identical.

**How to apply:** Separate pipeline completion from visual acceptance. Verify generated reference images and scene-opening compositions before rendering, then inspect boundary frames and cross-scene identity; never label a successful job as verified continuity.

An approved dressed character reference takes precedence over its original unclothed portrait and shared-library wardrobe descriptions.

**Why:** Supplying both looks makes clothing ambiguous. Even when production explicitly supplies its approved images, spare workflow slots can otherwise reintroduce an older library look.

**How to apply:** Treat project-approved appearance and recurring-prop references as complete snapshots, not additions to an automatically chosen library appearance. Reference approval is input acceptance, not proof that generated video preserved the look; inspect output frames too.

Scene animation must start from a reviewed composition containing the intended cast, outfits and props in the actual location—not an empty room plus competing portrait backgrounds.

**Why:** A live scene transition began in the workshop but ended against the neutral character-reference backdrop. Reference boards also produced duplicate characters and oversized props; separate native reference inputs improved composition but still required correction and human review.

**How to apply:** Use separate native reference conditioning, fail rather than drop excess references, and require explicit approval of the composed opening. Bind approval to current source images, identity, scene and output dimensions. Never auto-approve a generated candidate or equate successful rendering with visual continuity.

A reviewed opening is necessary input validation, not a demonstrated cure for H3 background drift.

**Why:** A second live two-scene test used the approved composition, correct empty workshop and a cropped prop reference with library fallbacks disabled. The workshop still changed into a neutral backdrop during close-ups. The character and vest remained recognizable, but scenery continuity failed.

**How to apply:** Do not advertise this H3 path as fully continuity-verified. Preserve failed outputs for comparison and obtain a deliberate workflow/model decision rather than repeating the same render or silently charging for a paid alternative.

Stable-exposure prompt text and a bright opening guide do not guarantee stable lighting through an H3 clip. An exposure check is a cascade safeguard, not a demonstrated prevention mechanism.

**Why:** A user-supplied fading clip was byte-identical to a retained worker output. Its actual prompt prohibited dimming, and its starting guide matched the bright approved composition. A matched-input, matched-seed comparison retained a bright ending after the negated unwanted-effect descriptions were replaced with positive illumination instructions. This supports the prompt correction for that example, not universal stability or a quantization/decoder diagnosis.

**How to apply:** Use positive-only automatic lighting descriptions, preserve explicitly authored lighting changes, and retain the exposure safeguard. Inspect the actual submitted graph, input images and raw worker output before attributing fading to prompts, previous-frame inheritance, precision, or a specific GPU. Distinguish a measured comparison from an unproven general diagnosis.

Shot correction requires stopping a running queue, not requiring every project to transition from running to paused. Keep the ordinary manual Pause command strict.

**Why:** A creator could not re-render a completed shot in a failed production because the correction flow unconditionally invoked the running-only Pause operation.

**How to apply:** Treat already-stopped projects as ready for correction, preserve protections for active shots and final assembly, and validate lifecycle decisions under the project lock. Refresh the separate render-query cache after correction success or failure; otherwise a stopped parent's cached status can hide a newly active shot. Keep polling while any child shot is active, even if the parent is paused or failed.

Shots must support re-rendering without an explicit correction. Corrections are optional. Both local and paid re-renders require confirmation before submission.

**Why:** The user explicitly requested a new render without having to describe a change, and subsequently objected to re-rendering starting without confirmation.

**How to apply:** Provide a direct re-render action, preserve the authored prompt when no correction is supplied, and retain active-render guards and paid-provider confirmation. Do not invent correction text to satisfy a required field.

Multi-step shot corrections must finish preparing the selected shots before scheduling background dispatch.

**Why:** Early automatic dispatch can acquire the project lock before a later step of the same request, reporting failure even though rendering already started.

**How to apply:** Keep dispatch paused throughout batch preparation and start it once afterwards. Preserve automatic dispatch for standalone operations. Do not hide genuine errors or retry submissions to conceal lock conflicts.

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

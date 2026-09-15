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
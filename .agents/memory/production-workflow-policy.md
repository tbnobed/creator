---
name: Guided production workflow policy
description: User requirements for story authoring, model choice, and honest continuity review
---

Summary-only productions should draft full scenes and dialogue for review, not merely a scene outline.

**Why:** The user explicitly chose complete scenes and dialogue when asked.

**How to apply:** Keep generated writing reviewable before rendering; do not treat a summary as a script to repeat across clips.

Offer compatible local and paid models at every generation step, rather than fixing character or wardrobe generation to FLUX.

**Why:** The user explicitly asked for the option to use any model, even paid, for all steps.

**How to apply:** Persist per-step choices, explain capability restrictions, and obtain paid-batch confirmation without silently switching models.

The script-generation model should run on the GB10 / Blackwell.

**Why:** The user explicitly requested GPU execution after encountering slow CPU-only script generation and selected GB10 / Blackwell as its host.

**How to apply:** Configure and verify a GPU-backed writing service; preserve the existing H100 reserved-slice boundary and coordinate capacity with video rendering.

The production system can reach the GB10 directly through its internal IP.

**Why:** The user explicitly confirmed local-network access; an additional production SSH tunnel is unnecessary.

**How to apply:** Prefer the private LAN endpoints for the API's writer and workload checks. SSH access is for administration or workspace-only verification, not a required application dependency.

Automatic continuity review may initially be a stub, but must not report that everything matches before a real check has run.

**Why:** The user requested a stubbed checker behind an interface; an empty stub result is not evidence of visual consistency.

**How to apply:** Distinguish not checked from checked with zero issues, and retain manual shot corrections.

Background generation updates must not block step navigation or overwrite unsaved creator edits.

**Why:** The production record advances while server work runs; treating every revision change as a competing human edit repeatedly blocked the user's Next action.

**How to apply:** Preserve revision checks, rebase only disjoint edits onto fresh server state, and require an explicit choice for competing edits to the same field. Never resolve this by blindly replacing the entire production snapshot.

Do not expand an authored short screenplay to a ten-minute preset. Support shorter custom targets and preserve supplied scene timing.

**Why:** The user supplied a three-minute test script and explicitly rejected its expansion to ten minutes; the original UI offered no shorter choice.

**How to apply:** Duration presets are goals for writing from summaries, not permission to pad existing scripts. Recognize screenplay content pasted into Summary too; preserve its boundaries and dialogue instead of blaming the selected input tab.

Writing must be cancellable, existing library characters reusable, and scenery removable from a production.

**Why:** The user explicitly requested these controls after being unable to stop a draft, find saved characters, or remove scenery. Production references can share media, so removing one reference must not destroy files used elsewhere.

**How to apply:** Stop the writing request rather than killing shared GPU services, retain creator input and completed work, and detach scenery only from the chosen production. Reusing a saved identity is not permission to regenerate its images or incur new charges.

Script location labels are display text, not the identity of an approved scenery reference.

**Why:** A generated location added “Gull Point” to the authored lantern-room label, and exact-name matching then rejected the already-created room. Renaming or generating duplicate scenery is not an acceptable requirement.

**How to apply:** Preserve authored location headings and allow explicit scene-to-place/variant assignments. Reuse approved references by ID; never silently substitute a vaguely similar room or fall back to a base image when a selected variant disappears.

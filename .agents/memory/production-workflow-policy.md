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

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

The script-generation model should run on one of the GPUs.

**Why:** The user explicitly requested GPU execution after encountering slow CPU-only script generation.

**How to apply:** Configure and verify a GPU-backed writing service; preserve the existing H100 reserved-slice boundary and coordinate capacity with video rendering.

Automatic continuity review may initially be a stub, but must not report that everything matches before a real check has run.

**Why:** The user requested a stubbed checker behind an interface; an empty stub result is not evidence of visual consistency.

**How to apply:** Distinguish not checked from checked with zero issues, and retain manual shot corrections.

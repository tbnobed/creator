---
name: Local image conditioning
description: Distinguish latent image-to-image from instruction editing and preserve sampler strength semantics.
---

Local image-to-image on generation checkpoints means latent conditioning, not guaranteed instruction-based editing.

**Why:** Accepting a reference image can otherwise imply that an ordinary generation checkpoint will reliably follow edits such as adding an object while preserving everything else.

**How to apply:** Describe this as image-guided generation/variation; dedicated instruction-edit checkpoints need their own verified integration.

Custom Flux sampling must preserve the intended number of sampling transitions when strength is reduced.

**Why:** Slicing a fixed four-step schedule by strength can round low values to zero sampling transitions. KSampler-style behavior expands the schedule first, then retains its final sampling steps.

**How to apply:** Verify the installed scheduler/sigma-splitting node schemas and test minimum, intermediate, and full strengths when changing custom sampling.
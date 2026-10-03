---
name: Garment video editing goals
description: Garment replacement and animated shirt content, not merely color adjustment.
---

The user chose replacing the garment like the Runway example rather than recoloring the existing shirt. They also said, “another example is that we will need to animate monkeys playing on the shirt.”

**Why:** A hue adjustment does not satisfy the chosen garment-replacement scope or the animated-content use case.

**How to apply:** Evaluate garment replacement and animated shirt content separately. Do not present still-image model availability, simple recoloring, or object removal as proof that either video workflow works.

The user chose “Animated shirt graphic”: a moving cartoon design that follows the shirt’s fabric and folds, not 3D-looking characters playing on its surface.

**Why:** The user explicitly selected this treatment.

**How to apply:** Animate the printed artwork independently and track it to the garment; do not treat a static generated shirt graphic as animation.

The monkey scene is an example, not a fixed product mode. Users must be able to choose existing or uploaded artwork and supply their own motion instructions.

The target garment must also be user-selected, not hard-coded to a shirt.

**Why:** The user explicitly rejected the hard-coded “Monkey print” feature and the hard-coded shirt segmentation target.

**How to apply:** Carry the chosen garment, artwork and instructions through segmentation and the real renderer. Never silently substitute a shirt target or canned monkey animation.

The printed artwork must look like part of the cloth, not just an animation positioned over it.

**Why:** The user rejected the initial motion-tracked proof as “superimposed” and said the monkeys “do not look like they are part of the shirt.”

**How to apply:** Evaluate local bending, cloth shadows and texture, seam continuity, and foreground occlusion—not just whether artwork follows overall torso movement. Do not call coarse tracking a finished fabric-print effect.

Keep local garment-editing capability gated on an inspected tracking mask and video result, not just model installation or successful execution.

**Why:** The requirement is stable clothing edits that preserve the actor and performance. A successful render with an empty/wrong mask or flickering garment does not satisfy it.

**How to apply:** Use short source-derived proofs before enabling batch processing, inspect hands and collar boundaries, retain original audio, and never silently substitute a paid cloud provider.

VACE's edit mask and its control-video pixels serve different purposes; a mask alone does not discard the original garment from conditioning.

**Why:** Initial proofs retained the original polo structure or ignored requested artwork when the unmodified shirt was supplied as reactive conditioning. The official inpainting blueprint explicitly clears the masked region before VACE encoding.

**How to apply:** Match the official preprocessing graph, not only its sampler and conditioning nodes. Preserve an untouched source separately for the final outside-mask composite and audio.

Keep interactive garment processing limited to short draft windows until longer windows and higher resolutions have their own quality evidence.

**Why:** The garment and moving-print proofs establish only a short, low-resolution result. They do not establish stable behavior across extended motion, deep folds, or occlusion.

**How to apply:** Treat expanded duration/resolution as a separate validation milestone; do not remove draft limits merely because a GPU has enough memory or a render completes.

VACE center-crops its reference input to the video aspect ratio. Portrait garment photos must be fitted to that ratio before conditioning.

**Why:** A portrait product photo fed directly into widescreen VACE conditioning loses its upper and lower design; correct upload handling does not prevent this model-side crop.

**How to apply:** Preserve the complete reference with aspect-preserving padding before worker upload. Test all four image edges, and keep artwork motion separate from garment replacement instructions. This prevents cropping; it is not proof of accurate generative transfer.

Garment runtime failures can be API-image packaging failures, not worker outages.

**Why:** Adding a required script without shipping it in the external API image blocked every worker despite passing workspace tests.

**How to apply:** Check packaged scripts whenever runtime requirements change. Distinguish API-host dependencies from worker readiness, and verify the external deployment separately from this workspace.
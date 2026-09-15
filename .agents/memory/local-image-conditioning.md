---
name: Local image conditioning
description: Distinguish latent image-to-image from instruction editing and preserve sampler strength semantics.
---

Local image-to-image on generation checkpoints means latent conditioning, not guaranteed instruction-based editing.

**Why:** Accepting a reference image can otherwise imply that an ordinary generation checkpoint will reliably follow edits while preserving identity.

**How to apply:** Distinguish latent variation from native reference editing. Graph tests establish wiring, not visual identity quality.

Character views use native FLUX.2 Klein reference editing, not source-latent warm starts.

**Why:** The official distilled checkpoint supports reference conditioning; treating it as ordinary img2img caused identity drift and resisted requested camera-angle changes.

**How to apply:** Preserve the entire source aspect for reference encoding and independently size the fresh target canvas. Validate actual worker node schemas. Never claim consistent identity without reviewing generated views.

Native reference editing is not sufficient evidence of character-view fidelity.

**Why:** Live verification still changed hair texture and clothing, added an unrequested prop, and produced a three-quarter angle despite a strict side-profile request.

**How to apply:** Judge requested angle, appearance details, and scene additions separately from pipeline success. Do not approve generated continuity references merely because the job completed.

Keep character biography out of source-based view-edit prompts.

**Why:** An occupation such as “podcast host” encourages scene props, while generic wardrobe descriptions compete with the photographed garment.

**How to apply:** Treat the selected original as authoritative for appearance and add only the requested view change plus explicit user edits. Keep biography-driven prompting for source-free generation.

For ordinary latent img2img, when source and target aspect ratios differ, preserve proportions with a center crop rather than stretching.

**Why:** Stretching a landscape character reference into a portrait latent distorts facial proportions before sampling; generation can retain that distortion.

**How to apply:** Keep exact requested output dimensions and accept cropped edges as the default tradeoff. Existing distorted outputs are not repaired by changing preprocessing.

Expose sampler progress as sampler progress, not estimated whole-render completion.

**Why:** Model loading, encoding, sampling, and saving have different costs; step counts only measure sampling. A connected observer may miss earlier events when attaching to an already-running job.

**How to apply:** Show actual steps and elapsed time when available, and an explicit waiting/stale state otherwise. Never restart or resubmit a render merely to obtain telemetry.

Custom Flux sampling must preserve the intended number of sampling transitions when strength is reduced.

**Why:** Slicing a fixed four-step schedule by strength can round low values to zero sampling transitions. KSampler-style behavior expands the schedule first, then retains its final sampling steps.

**How to apply:** Verify the installed scheduler/sigma-splitting node schemas and test minimum, intermediate, and full strengths when changing custom sampling.

Inspect only the ComfyUI node classes needed for a local image workflow.

**Why:** On the connected workers, the full capability inventory can time out while individual node queries respond promptly. A preparation failure is not evidence that a GPU render ran.

**How to apply:** Use targeted node inspection, preserve exact model-file checks, and log preparation failures separately from attempted submissions.

Character view generation should preserve the original canonical reference rather than automatically promote each new output.

**Why:** Repeatedly using the newest generated image compounds identity drift. A labeled reference library is not useful for continuity unless the actual selected source reaches the model.

**How to apply:** Prefer the explicit primary/original source, snapshot its selection for queued jobs, and require a deliberate producer action to change it. Treat capability checks and image uploads as retry-safe preparation, separate from uncertain render submission.

Do not test missing-worker capability through a shared-environment generation endpoint.

**Why:** A scheduler may skip the deliberately broken mock and select a real GPU, even when the mock has highest priority.

**How to apply:** Test negative scheduling cases with injected candidate lists and capability inspectors. A high-priority mock alone is not render isolation.
---
name: MiniMax H3 prompt and audio rules
description: Native full-reference prompt grammar and the distinction between semantic gibberish and sampler distortion.
---

MiniMax H3 full-reference workflows should use the official six-section schema: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music`. Give speakers stable IDs and put exact speech alone inside `<d>[Language] ...</d>`.

**Why:** Generic headings and prose such as “beneath the narration” provide no exact utterance for the joint video/audio model. Separately, older ComfyUI audio/video sampling and early Turbo LoRA workflows can produce distorted audio even with a correct prompt.

**How to apply:** Compile reference jobs into the native schema, distinguish on-screen speech from off-screen voiceover, keep dialogue within clip duration, preserve reference-video source audio when exactness matters, and require an updated ComfyUI build with native audio/video sampling fixes.

Preserve the empirically working standard/image-reference speech grammar even when official prompt guidance suggests a cleaner equivalent. Dialogue appears once inside `<d>`, but the established speaker-event wording and soundscape clarity reinforcement are part of the conditioning contract.

**Why:** Replacing the working standard compiler with narrator-aware subject binding and cleaner speaker wording caused output to regress from intelligible speech to gibberish, despite remaining structurally valid.

**How to apply:** Keep reference-video prompt experiments physically isolated. For standard jobs, do not force the first selected cast member into an off-screen narrator subject, reorder speech conditioning, or rewrite the established `says clearly at a natural speaking rate` / voiceover event without an audible A/B render.

Authored `Camera:` and `Motion:` lines in structured long-form blocks take precedence over planner defaults. For long-form shots, only describe a project-selected character or setting as appearing when the shot text calls for that reference. For a standalone single-video generation, explicitly selected cast and environment are intended for that shot even if its short prompt does not name them.

**Why:** Appending generic framing after authored direction creates contradictory H3 prompts, while forcing every project reference into every long-form shot makes B-roll and alternate environments reproduce the wrong subject or set. Conversely, filtering standalone selections by name caused a creator's selected cast and environment to disappear from the compiled prompt despite being saved on the job.

**How to apply:** Detect authored camera/motion labels before appending defaults. Use shot-body reference retention for long-form shots; treat direct single-video asset selections as authoritative for that one shot. Keep this distinction for both standard and reference-video H3 prompt paths.
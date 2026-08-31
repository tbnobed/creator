---
name: MiniMax H3 prompt and audio rules
description: Native full-reference prompt grammar and the distinction between semantic gibberish and sampler distortion.
---

MiniMax H3 full-reference workflows should use the official six-section schema: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music`. Give speakers stable IDs and put exact speech alone inside `<d>[Language] ...</d>`.

**Why:** Generic headings and prose such as “beneath the narration” provide no exact utterance for the joint video/audio model. Separately, older ComfyUI audio/video sampling and early Turbo LoRA workflows can produce distorted audio even with a correct prompt.

**How to apply:** Compile reference jobs into the native schema, distinguish on-screen speech from off-screen voiceover, keep dialogue within clip duration, preserve reference-video source audio when exactness matters, and require an updated ComfyUI build with native audio/video sampling fixes.

Keep each section concise and non-redundant. Dialogue appears once inside `<d>` in the shot description; soundscape does not repeat it, retention does not carry speaker IDs, and ordinary voice attributes do not need defensive negative instructions.

**Why:** The official MiniMax guide requires detailed visual/audio timing, not repeated policy prose. Redundant gender, lip-motion, clarity, and fallback warnings compete with the actual shot.

**How to apply:** Use one short subject definition, one short retention relationship, and a direct `(S1) says: <d>…</d>` event. Do not append generic camera or motion defaults when the shot already authors them.

Authored `Camera:` and `Motion:` lines in structured long-form blocks take precedence over planner defaults. Only describe a selected character or setting as appearing in the H3 shot when the shot text actually calls for that reference.

**Why:** Appending generic framing after authored direction creates contradictory H3 prompts, while forcing every project reference into every shot makes B-roll and alternate environments reproduce the wrong subject or set.

**How to apply:** Detect authored camera/motion labels before appending defaults, and determine shot-level reference retention from the shot body before the project-wide visual direction is added.
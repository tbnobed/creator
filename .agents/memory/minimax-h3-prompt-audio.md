---
name: MiniMax H3 prompt and audio rules
description: Native full-reference prompt grammar and the distinction between semantic gibberish and sampler distortion.
---

MiniMax H3 full-reference workflows should use the official six-section schema: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music`. Give speakers stable IDs and put exact speech alone inside `<d>[Language] ...</d>`.

**Why:** Generic headings and prose such as “beneath the narration” provide no exact utterance for the joint video/audio model. Separately, older ComfyUI audio/video sampling and early Turbo LoRA workflows can produce distorted audio even with a correct prompt.

**How to apply:** Compile reference jobs into the native schema, distinguish on-screen speech from off-screen voiceover, keep dialogue within clip duration, preserve reference-video source audio when exactness matters, and require an updated ComfyUI build with native audio/video sampling fixes.
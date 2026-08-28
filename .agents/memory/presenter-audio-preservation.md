---
name: Presenter audio preservation
description: Why presenter-video workflows should retain the uploaded source track instead of decoded model audio.
---

Presenter-video outputs should preserve the uploaded source audio while still using it to condition lip sync. Do not replace that track with model-decoded audio unless the workflow is explicitly intended to synthesize speech.

**Why:** Model-generated audio can begin correctly and drift into nonsensical speech partway through longer clips. Exact presenter dialogue is more important than regenerated ambience.

**How to apply:** For reference-video workflows, feed source audio into the model for conditioning and route the original source audio to the final video mux. Treat generated speech or TTS as a separate, explicit workflow.
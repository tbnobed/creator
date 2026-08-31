---
name: Presenter audio preservation and replacement
description: When presenter-video workflows should preserve source audio versus clone its voice for exact replacement dialogue.
---

Presenter-video outputs should preserve the uploaded source audio when no replacement dialogue is supplied. Explicit exact dialogue changes the operation: use source audio only as a voice-identity reference, replace the original words completely, and synthesize only the supplied line.

**Why:** Unconditionally preserving source audio contradicts explicit voice-cloning requests, while unconditionally generating audio risks gibberish and needless loss of a valid source track.

**How to apply:** Branch on exact dialogue in both conditioning and output routing. Without dialogue, mux the synchronized source track. With dialogue, use source audio as voice-reference-only, allow mouth articulation to change, and mux the model-decoded audio. Prompt wording cannot override a graph that still routes source audio to the output.

Reference-video prompt compilation and audio routing must remain physically separate from standard image-reference and long-form H3 generation.

**Why:** Sharing reference-video voice-cloning branches with standard jobs creates unnecessary regression risk for cast identity, narrator gender, and normal generated audio.

**How to apply:** Dispatch to the presenter-video compiler only when a reference video is actually attached. Keep its graph mutation behind the same runtime condition, and verify the standard compiler contains no video/audio-reference logic.
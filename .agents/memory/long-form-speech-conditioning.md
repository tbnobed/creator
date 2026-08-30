---
name: Long-form speech conditioning
description: Prompt-order and duration constraints for intelligible MiniMax speech in independently rendered long-form shots.
---

Keep MiniMax H3 conditioning limited to the individual shot block, with exact dialogue early, and allocate enough duration for the complete spoken line. Never inject project-wide Visual Storyline text into an H3 speech prompt.

**Why:** MiniMax can produce clear speech from a concise single-shot prompt, but long project-level context can push dialogue too late in the conditioning input, while undersized clips may produce only a few intelligible words followed by gibberish.

**How to apply:** Compile H3 from shot-specific visual, camera, motion, audio, and dialogue fields only. Keep Visual Storyline as planning metadata. Estimate minimum duration from word count and leave natural lead/trailing room.
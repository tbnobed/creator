---
name: Long-form speech conditioning
description: Prompt-order and duration constraints for intelligible MiniMax speech in independently rendered long-form shots.
---

Place exact dialogue before long visual context in the model-conditioning prompt, and allocate each shot enough duration for its complete spoken line. Do not force a structured multi-shot script into a shorter total runtime than its dialogue can naturally occupy.

**Why:** MiniMax can produce clear speech from a concise single-shot prompt, but long project-level context can push dialogue too late in the conditioning input, while undersized clips may produce only a few intelligible words followed by gibberish.

**How to apply:** Prioritize character and dialogue conditioning before action and project-wide visual direction. Estimate a minimum duration from the dialogue’s word count, add natural lead/trailing room, and expand the planned runtime or require additional shots when necessary.
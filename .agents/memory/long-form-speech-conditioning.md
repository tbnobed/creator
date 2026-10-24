---
name: Long-form speech conditioning
description: Prompt-order and duration constraints for intelligible MiniMax speech in independently rendered long-form shots.
---

Keep MiniMax H3 conditioning limited to the individual shot block, with exact dialogue early, and allocate enough duration for the complete spoken line. Never inject project-wide Visual Storyline text into an H3 speech prompt.

**Why:** MiniMax can produce clear speech from a concise single-shot prompt, but long project-level context can push dialogue too late in the conditioning input, while undersized clips may produce only a few intelligible words followed by gibberish.

**How to apply:** Compile H3 from shot-specific visual, camera, motion, audio, and dialogue fields only. Keep Visual Storyline as planning metadata. Estimate minimum duration from word count and leave natural lead/trailing room.

For authored scripts, allocate original speech deterministically before requesting visual shot descriptions; do not depend on an LLM copying dialogue verbatim.

**Why:** Copying through the writer produced rejected drafts and could drop wrapped lines. Repeated speech padding on very short shots also reduces usable dialogue time.

**How to apply:** Preserve words and speaker order, count only speech consistently in planning and rendering, and keep the scene's authored total fixed. Use longer takes within supported limits when needed; reject genuinely impossible timing rather than silently deleting speech or expanding the scene.

Use one minutes-and-seconds target control for summaries, not fixed Test/Short/Episode/Feature cards.

**Why:** The user repeatedly rejected preset durations and the extra controls added around them.

**How to apply:** Support sub-minute targets and retain authored script timings rather than forcing scripts to match a summary target.
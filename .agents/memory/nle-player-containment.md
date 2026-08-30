---
name: NLE player containment
description: Flex-layout constraint required for showing an entire source frame in the editor player.
---

The desktop NLE workspace must be allowed to shrink within the height left by its header, controls, and timeline. The video should fit a definite bounded viewport rather than contributing its intrinsic aspect-ratio height to flex layout.

**Why:** A hard workspace minimum can exceed the editor’s available height. The outer overflow boundary then clips the lower part of the player even when the video itself uses `object-contain`, making the failure look like a video crop.

**How to apply:** Put `min-height: 0` through the desktop flex chain and contain the video inside a definite viewport. Keep larger minimum heights mobile-only, where the editor can scroll vertically.
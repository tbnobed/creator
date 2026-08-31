---
name: Presenter audio preservation and replacement
description: When presenter-video workflows should preserve source audio versus clone its voice for exact replacement dialogue.
---

Presenter-video outputs should preserve the uploaded source audio when no replacement dialogue is supplied. Explicit exact dialogue changes the operation: use source audio only as a voice-identity reference, replace the original words completely, and synthesize only the supplied line.

**Why:** Unconditionally preserving source audio contradicts explicit voice-cloning requests, while unconditionally generating audio risks gibberish and needless loss of a valid source track.

**How to apply:** Branch on exact dialogue. Without dialogue, copy the synchronized source track. With dialogue, mark source audio as voice-reference-only and state that its spoken content must be discarded and replaced exactly.
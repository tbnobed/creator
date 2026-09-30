---
name: Cloud native-resolution policy
description: Why Google video output choices are deliberately narrower than provider enums.
---

Keep Google cloud video generation at 720p unless the user explicitly chooses to restore higher-resolution output. Do not add automatic upscaling.

**Why:** The user wants to avoid paying for nominally higher-resolution video without corresponding native detail, and prefers separate Topaz upscaling. Fal accepting a resolution parameter is not proof of native generation resolution. The Veo restriction is an application policy, not a claim that its provider rejects 1080p or 4K.

**How to apply:** Distinguish native generation from upscaled output when adding models, enforce offered resolutions before paid submission, and verify provider documentation rather than interpreting dropdown enums as native-quality guarantees.

Explicitly requested Topaz/Fal enhancement is separate from this native-generation restriction and must remain opt-in for both cloud and local source videos.

**Why:** The user approved Topaz as a separate paid finishing step, not as permission to automatically upscale or increase the cost of every generation.

**How to apply:** Keep cost confirmation and original preservation in the finishing workflow; do not enable provider-side generation upscaling as a substitute.
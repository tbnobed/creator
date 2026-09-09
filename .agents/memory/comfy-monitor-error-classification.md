---
name: Comfy monitor error classification
description: Distinguishes transient Comfy request failures from output-finalization failures.
---

Only transient network, timeout, interrupted-transfer, and retryable Comfy HTTP errors should count toward consecutive worker request failures. Workflow validation, malformed responses, database, storage, voice-cloning, muxing, and other output-finalization errors must retain their actual cause and must not change server health.

**Why:** Output retrieval and local finalization previously shared one broad catch block, so a healthy GPU worker could be reported as unresponsive when voice processing, storage, or another downstream step failed.

**How to apply:** Keep request errors typed at the Comfy client boundary. Let the independent health checker own online/offline status, and make generation monitors retry only explicitly transient request failures.
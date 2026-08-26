---
name: Long-form GPU capacity
description: Safe concurrency rule for ComfyUI workers serving long-form projects.
---

Use one active MiniMax/ComfyUI render per GPU as the baseline. Raise worker concurrency only after recording a workload-specific benchmark that shows memory headroom and stable completion behavior.

**Why:** Multiple ComfyUI processes can duplicate model memory and make a worker unstable or out-of-memory; a queue that is slower but reliable is preferable to silently losing long-form shots.

**How to apply:** Any scheduler, short generation path, or project dispatcher with no explicit worker capacity must interpret that missing value as one slot. Capacity changes should be deliberate and validated against the intended workflow, resolution, duration, and GPU.
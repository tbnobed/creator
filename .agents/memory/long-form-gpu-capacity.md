---
name: Long-form GPU capacity
description: Safe concurrency rule for ComfyUI workers serving long-form projects.
---

Long-form shots are distributed across independent GPU workers, with one active MiniMax/ComfyUI render per GPU as the baseline. Do not assume shots share model state, prompt context, timing, or audio state across workers. Raise worker concurrency only after recording a workload-specific benchmark that shows memory headroom and stable completion behavior.

**Why:** Multiple ComfyUI processes can duplicate model memory and make a worker unstable or out-of-memory. Independent workers also cannot maintain continuity between shots; a queue that is slower but reliable is preferable to silently losing long-form shots or assuming cross-GPU continuity.

**How to apply:** Any scheduler, short generation path, or project dispatcher with no explicit worker capacity must interpret that missing value as one slot. Treat continuity, presenter identity, voice consistency, and final audio mixing as explicit inputs or post-processing steps, not as shared GPU state. Capacity changes should be deliberate and validated against the intended workflow, resolution, duration, and GPU.
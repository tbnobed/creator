---
name: Long-form worker compatibility
description: Prevents long-form projects appearing to run while no shot can be dispatched.
---

Dispatch must require an online worker with normalized matching tags, free render capacity, and an active workflow whose node classes and model files are present. Model-family tags must be capability-gated; GPU class alone must never grant them.

**Why:** Existing worker rows can retain legacy tag names or casing across upgrades, and `/system_stats` can report a healthy high-memory GPU even while `/object_info` lacks a required custom loader or model filename. Premature tags turn a safe incompatibility into a queued render failure.

**How to apply:** Normalize configured tags during idempotent seeding, but add model-family tags only after probing every required node class and installed filename. Compare tags case-insensitively and log whether dispatch is waiting on a workflow, capability, or free slot.
---
name: Long-form worker compatibility
description: Prevents long-form projects appearing to run while no shot can be dispatched.
---

Long-form dispatch must require an online worker with normalized matching tags, free render capacity, and an active imported workflow that accepts character-image references rather than presenter video.

**Why:** Existing Docker worker rows can retain legacy tag names or casing across upgrades. A health probe can still report those workers online while exact workflow-tag matching rejects every worker, leaving projects at zero progress without a generation.

**How to apply:** Merge canonical tags into configured worker records during idempotent startup seeding, compare tags case-insensitively, and persist/log the reason whenever dispatch is waiting for a workflow, compatible worker, or free slot.
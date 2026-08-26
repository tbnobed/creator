---
name: Long-form project deletion
description: Safety behavior for removing long-form projects and their render records.
---

Project deletion is allowed for saved projects that are not currently `RUNNING` or `ASSEMBLING`. Active projects must be paused or cancelled before deletion so an in-flight orchestrator cannot lose its project state unexpectedly.

**Why:** Deleting an active project can race child render cancellation and orchestration, leaving remote GPU work orphaned or making progress recovery impossible.

**How to apply:** Keep the UI action disabled or hidden for active states, and enforce the same rule in the API. When deleting, clear shot-to-job references before removing child generation records and remove only media owned by the project.
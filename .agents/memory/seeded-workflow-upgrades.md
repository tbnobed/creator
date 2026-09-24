---
name: Seeded workflow upgrades
description: How to handle persisted workflow templates after seeded mappings or graphs change
---

When an app-managed workflow seed changes, existing database records can retain older mappings even though fresh installs receive the corrected definition. Check persisted records separately from source definitions before treating a generation failure as a user-input problem.

**Why:** A MiniMax H3 submission failed preflight because older seeded templates still had a frame-count mapping that bypassed the current duration/frame-grid contract. The source seed and its dry-graph tests were already correct.

**How to apply:** Reconcile only recognizable app-managed stale records, matching their identity and relevant graph/mapping shape; preserve creator-imported or customized workflows. After restart, verify the persisted mapping and run a dry graph test before considering a paid render.

Partially upgraded graphs may combine a current model component with an older, incompatible one, so equality against an entire previous seed is not enough to recognize them.

**Why:** A Blackwell-tagged H3 template retained an A100 UNet after its Blackwell text encoder had already been updated. The exact-old-graph upgrade missed this mixed state and ComfyUI rejected the job.

**How to apply:** For known incompatible seed-model pairs, match the template identity, hardware tags, node classes, and specific stale filename; repair only the mismatched node while preserving unrelated graph edits. Also fail before submission when a known seeded model file conflicts with the selected worker class.
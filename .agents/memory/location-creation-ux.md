---
name: Simple location creation
description: Keep basic location creation prompt-first without duplicate descriptions or mandatory advanced metadata.
---
Location creation should ask for a name and one shared description, followed by generating or uploading an image and saving. Keep tags, extra references, image naming, and image editing optional.

**Why:** The user objected to the complexity and repeated description fields, then requested the simpler flow. Simplifying must retain the newer generation, editing, and model-selection capabilities.

**How to apply:** Do not require a second base-image prompt or a separately authored card summary. Preserve existing separately authored summaries and media when editing; retain model selection and explicit paid confirmation.

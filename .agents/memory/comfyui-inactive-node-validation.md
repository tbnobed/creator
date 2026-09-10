---
name: ComfyUI inactive-node validation
description: Prevents optional model branches from invalidating an otherwise usable submitted workflow.
---

ComfyUI validates model and LoRA selections on nodes in disabled switch branches before accepting a prompt. Do not leave unavailable optional loaders in an API workflow merely because a switch routes around them.

**Why:** A disabled Turbo LoRA branch caused prompt validation to fail with `value_not_in_list` on workers that correctly had the base MiniMax model but not the optional LoRA.

**How to apply:** Remove inactive optional model nodes from submitted workflows, or generate a worker-specific workflow containing only assets confirmed to exist on that worker.

Do not infer mandatory references from an R2V label or the presence of reference mappings. Reference support and reference requirements are separate capabilities.

**Why:** MiniMax H3 accepts empty reference lists, and Wan 2.2 TI2V's start image is optional even in its image-to-video template. Both construct fresh latents without uploads. The app previously blocked these valid prompt-only paths by treating reference mappings or I2V names as mandatory-image requirements.

**How to apply:** Verify optionality against the node schema and execution semantics. Keep truly required I2V inputs protected, and prune omitted optional loaders rather than inventing placeholder images.
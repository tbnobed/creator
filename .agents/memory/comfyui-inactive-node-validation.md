---
name: ComfyUI inactive-node validation
description: Prevents optional model branches from invalidating an otherwise usable submitted workflow.
---

ComfyUI validates model and LoRA selections on nodes in disabled switch branches before accepting a prompt. Do not leave unavailable optional loaders in an API workflow merely because a switch routes around them.

**Why:** A disabled Turbo LoRA branch caused prompt validation to fail with `value_not_in_list` on workers that correctly had the base MiniMax model but not the optional LoRA.

**How to apply:** Remove inactive optional model nodes from submitted workflows, or generate a worker-specific workflow containing only assets confirmed to exist on that worker.
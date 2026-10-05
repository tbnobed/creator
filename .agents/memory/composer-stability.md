---
name: Composer interaction stability
description: Creator requirements for stationary controls, field focus, and identifying renders.
---

Typing, readiness changes, active shot direction, and render notifications must not move the builder fields or composer toolbar. Associate visible labels with their inputs and reserve bounded space for changing status.

**Why:** The creator repeatedly reported typing into the wrong field and controls moving as messages appeared. A smaller panel alone did not solve the interaction problem.

**How to apply:** Check element positions before and after first keystrokes and status transitions. Exercise clicking labels, not just filling inputs by selector.

Use the authored prompt to identify gallery shots; a generated title may only contain the model name. Completion notices must identify and link to their render.

**Why:** The creator reported that model-name titles made similar shots indistinguishable.

**How to apply:** Preserve meaningful shot identification when changing card metadata or completion feedback.

Active shot direction must remain visible separately from scrollable notifications after submitting a render.

**Why:** The creator reported that a fixed-height shared box hid carried-over direction behind the acceptance notice. A scrollbar is not sufficient disclosure of settings that affect the next render.

**How to apply:** Reserve separate stationary space for persistent settings and verify visibility with acceptance and completion notices present.

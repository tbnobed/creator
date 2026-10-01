---
name: Worker history preservation
description: Intent behind history-preserving fleet removal and concurrent dispatch protection.
---

Treat removing a worker as retirement from the operational fleet, not permission to purge its historical identity or unlink prior work.

**Why:** The user explicitly needs to remove obsolete fleet entries while retaining linked jobs and shots. Preserving output files alone is insufficient if attribution or historical links disappear.

**How to apply:** Keep historical reads independent of fleet visibility. Block removal for active assigned work, and serialize removal with every new assignment or recovery that reactivates work. Do not replace this behavior with cascading deletion or foreign-key nulling.
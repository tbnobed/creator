---
name: H100 MIG scope
description: CreatorAI-only partition assignments and the reserved slice boundary.
---

The requested layout is one 4g.40gb and one 3g.40gb instance on each H100. CreatorAI may use both instances on physical GPU 0 and only the 4g.40gb instance on physical GPU 1. The GPU 1 3g.40gb instance is reserved for another internal service: create it, leave it idle, assign nothing, and do not set up or touch that service.

**Why:** The operator explicitly limited migration scope to CreatorAI and reserved the fourth slice.

**How to apply:** This is the target layout, not evidence migration has completed. Verify profile-to-instance mappings instead of assuming MIG index order. Exclude the reserved instance from workers, dispatch, and tests. Back up configuration, pause intake in the actual serving portal, drain jobs, and verify no GPU clients remain before changing MIG mode.

The reserved slice is not necessarily idle: other internal AI services now use it. Preserve those workloads rather than trying to restore the historical empty-slice state.

**Why:** Recovery inspection found existing embedding and language-model services on the host; the original reservation forbids CreatorAI assignments, not the owner's internal services.

**How to apply:** Verify CreatorAI remains on its three allowed slices, leave other services untouched, and disclose their interruption before any host reboot.

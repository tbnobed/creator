---
name: Git provider authorization
description: Distinguish GitHub connection badges and read access from actual push authorization.
---

An active or healthy GitHub connection badge does not establish working push authorization; successful remote reads can be anonymous.

**Why:** Native Git push returned “Invalid username or token” while Replit reported the source-control connection healthy. Listing also marked that connection not added, but attaching it reported that it was already active and native Git authenticates through it automatically.

**How to apply:** Trust actual Git authorization errors over UI badges. Use the documented integration reauthorization flow for the exact failed connection, then retry once. Do not extract credentials or assume an API integration needs manual credential wiring into Git.

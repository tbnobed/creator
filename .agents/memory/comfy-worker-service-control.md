---
name: ComfyUI worker service control
description: Safely restarts heterogeneous remote ComfyUI installations without losing their Python environment.
---

Never infer a ComfyUI worker's startup interpreter or restart mechanism from its current executable path alone. Discover the running process, its command line, available venvs, queue state, and service manager before restarting it.

**Why:** A shell-launched process can resolve to the system Python executable while still depending on packages from a nearby venv. Recreating it from a fresh non-login shell with bare system Python can fail immediately even though the original process was healthy.

**How to apply:** Require an empty ComfyUI queue, prefer the installation's venv when present, preserve the existing command flags, use the registered systemd unit when one exists, and wait for `/system_stats` before considering the restart complete.
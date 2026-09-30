---
name: ComfyUI worker service control
description: Safely restarts heterogeneous remote ComfyUI installations without losing their Python environment.
---

Never infer a ComfyUI worker's startup interpreter or restart mechanism from its current executable path alone. Discover the running process, its command line, available venvs, queue state, and service manager before restarting it.

**Why:** A shell-launched process can resolve to the system Python executable while still depending on packages from a nearby venv. Recreating it from a fresh non-login shell with bare system Python can fail immediately even though the original process was healthy.

**How to apply:** Require an empty ComfyUI queue, prefer the installation's venv when present, preserve the existing command flags, use the registered systemd unit when one exists, and wait for `/system_stats` before considering the restart complete.

For authenticated model downloads, never place bearer tokens in remote command arguments or curl `--header` arguments. Feed authorization through curl configuration on stdin so process listings and diagnostic output cannot reveal the credential.

**Why:** Remote process inspection can surface complete command arguments even when the initiating shell command referenced only an environment variable.

**How to apply:** Pass the token into the remote shell over stdin, keep it out of shell history and process arguments, and rotate it immediately if any diagnostic output exposes it.

Do not accept a newly provisioned multi-GPU worker based only on initial `/system_stats` success. Check each physical GPU's stability and temperatures before enabling it for dispatch.

**Why:** Both services on a new passive-H100 host initially responded successfully, then one GPU reported fatal PCIe errors while another overheated at modest power. Initial CUDA enumeration was not evidence of a stable replacement.

**How to apply:** Pin processes to physical GPU UUIDs, validate them separately and concurrently, and stop services rather than retrying indefinitely after Xid 79, fatal PCIe recovery failures, or unsafe temperatures. Keep model downloads separate from GPU service startup.
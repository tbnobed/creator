---
name: ComfyUI worker service control
description: Safely restarts heterogeneous remote ComfyUI installations without losing their Python environment.
---

Never infer a ComfyUI worker's startup interpreter or restart mechanism from its current executable path alone. Discover the running process, its command line, available venvs, queue state, and service manager before restarting it.

Both dual-H100 ComfyUI workers should start automatically at boot.

**Why:** On 2026-10-05, after a reboot left both workers stopped, the operator explicitly selected “Start now and enable at boot.”

**How to apply:** Preserve boot enablement for both existing worker services and their power/safety dependencies. This does not authorize restoring the custom thermal cutoffs or changing dispatch eligibility.

**Why:** A shell-launched process can resolve to the system Python executable while still depending on packages from a nearby venv. Recreating it from a fresh non-login shell with bare system Python can fail immediately even though the original process was healthy.

**How to apply:** Require an empty ComfyUI queue, prefer the installation's venv when present, preserve the existing command flags, use the registered systemd unit when one exists, and wait for `/system_stats` before considering the restart complete.

Do not assume historical ComfyUI VRAM flags still exist on newer workers.

**Why:** The Blackwell server's installed build rejects `--normalvram`; its default memory policy starts successfully without that flag.

**How to apply:** Check the installed CLI help before creating services. Pin each worker to a physical GPU UUID and validate the device returned by its own endpoint.

The operator requested that Blackwell worker access not be restricted to only the OBTV API server's IP.

**Why:** The user explicitly said, “do not restrict access to just this ip.”

**How to apply:** Do not introduce a single-source-IP allowlist for these workers. Keep router forwarding unchanged unless separately authorized; unrestricted source access on a trusted network does not authorize public exposure.

For authenticated model downloads, never place bearer tokens in remote command arguments or curl `--header` arguments. Feed authorization through curl configuration on stdin so process listings and diagnostic output cannot reveal the credential.

**Why:** Remote process inspection can surface complete command arguments even when the initiating shell command referenced only an environment variable.

**How to apply:** Pass the token into the remote shell over stdin, keep it out of shell history and process arguments, and rotate it immediately if any diagnostic output exposes it.

Do not accept a newly provisioned multi-GPU worker based only on initial `/system_stats` success. Check each physical GPU's stability and temperatures before enabling it for dispatch.

**Why:** Both services on a new passive-H100 host initially responded successfully, then one GPU reported fatal PCIe errors while another overheated at modest power. Initial CUDA enumeration was not evidence of a stable replacement.

**How to apply:** Pin processes to physical GPU UUIDs, validate them separately and concurrently, and stop services rather than retrying indefinitely after Xid 79, fatal PCIe recovery failures, or unsafe temperatures. Keep model downloads separate from GPU service startup.

For the dual-H100 workstation, check BMC thermal events before treating GPU disappearance as a driver-install problem. Passive GPU cooling must work independently of CPU load.

**Why:** Inspection on 2026-09-30 found a PCIe-slot critical-temperature event before fatal surprise-link-down errors on both GPU links. The supplied screenshot showed GPUs at 93°C/85°C with no compute processes, while the CPU was cool. GPU initialization failures and ECC messages after the link loss did not establish the original cause.

**How to apply:** Read BMC sensors/event logs and the first kernel error sequence, not just the final NVIDIA errors. Require adequate directed airflow and safe idle temperatures before any stress test; do not assume CPU-based chassis fan curves cool passive accelerators.

Verify an enforced power cap throughout a GPU test, not only the success message from setting it.

**Why:** On the dual-H100 host, a temporary 250 W setting was accepted but reverted to 350 W before CUDA load with persistence disabled. Temporarily enabling persistence kept the requested cap enforced. Without telemetry readback, the test would have been incorrectly reported as a lower-power test.

**How to apply:** Record original power limits and persistence state, keep GPU initialization alive during the test, and fail closed if the enforced limit rises. Restore both settings in cleanup and independently verify them afterward. A conservative test temperature cutoff is not the manufacturer's hardware-failure threshold.

Assess sustained real-workload temperature behavior separately from the earlier conservative benchmark cutoff.

**Why:** On 2026-10-01 the operator reported an hour of video generation with both H100s holding around 79°C at 250 W caps after disabling the custom cutoffs. This is user-reported sustained workload evidence, not an independently monitored stability certification. The earlier 70°C test abort should not be described as proof that these workloads cannot run.

**How to apply:** Retain that distinction when discussing cooling or operational readiness. Do not generalize the reported result to every workload or to memory temperatures, throttling, or output quality that were not measured.

Stable H100 temperatures near 79°C do not establish cooling headroom or unthrottled performance.

**Why:** Read-only monitoring on 2026-10-03 found both dual-H100 cards continuously busy but predominantly thermally throttled, even with power draw below their enforced 250 W caps. A steady temperature can reflect the driver reducing clocks to hold that temperature.

**How to apply:** Check live thermal and power-limit event reasons alongside clocks and power before recommending a higher cap. Address airflow first when thermal throttling dominates; neither clock ratios nor power-cap ratios directly measure render-time loss.
---
name: ComfyUI worker service control
description: Safely restarts heterogeneous remote ComfyUI installations without losing their Python environment.
---

Never infer a ComfyUI worker's startup interpreter or restart mechanism from its current executable path alone. Discover the running process, its command line, available venvs, queue state, and service manager before restarting it.

Do not equate a failed external ComfyUI request or stored OFFLINE status with an inaccessible GPU server. Check the documented SSH endpoints and query ComfyUI locally through SSH.

**Why:** The dual-H100 server had three running, locally reachable ComfyUI workers while its external API checks failed. The user reiterated that SSH access to the fleet was already provided.

**How to apply:** Use the connection details in replit.md and existing secrets without asking for them again. Report SSH reachability, local service health, and public API reachability separately; inspect queues before changes.

During GPU-loss recovery, hold worker startup across the reboot until physical GPU and MIG validation completes; do not rely on temporary firewall rules surviving reboot.

The operator reports the H100 failure happens consistently during model swapping and says the physical seating/power/airflow checks have already been tested.

**Why:** The user explicitly corrected the investigation focus; repeating the physical checklist does not advance diagnosis.

**How to apply:** Prioritize controlled comparisons of model loading/unloading, ComfyUI dynamic VRAM, CUDA allocation/offload behavior, and driver/firmware. Treat model swapping as the reported trigger, not proof of a particular software root cause. Preserve the reserved MIG workload and require approval for disruptive host recovery.

**Why:** Boot-enabled workers can accept portal retries before recovery checks, even when the live portal's administrative connection is unavailable.

**How to apply:** Use a temporary persistent service-start condition, verify hardware and assigned profiles, then test through loopback with external intake blocked before restoring normal startup and intake. Keep the reserved slice unassigned.

Both dual-H100 ComfyUI workers should start automatically at boot.

**Why:** On 2026-10-05, after a reboot left both workers stopped, the operator explicitly selected “Start now and enable at boot.”

**How to apply:** Preserve boot enablement for both existing worker services and their power/safety dependencies. This does not authorize restoring the custom thermal cutoffs or changing dispatch eligibility.

**Why:** A shell-launched process can resolve to the system Python executable while still depending on packages from a nearby venv. Recreating it from a fresh non-login shell with bare system Python can fail immediately even though the original process was healthy.

**How to apply:** Require an empty ComfyUI queue, prefer the installation's venv when present, preserve the existing command flags, use the registered systemd unit when one exists, and wait for `/system_stats` before considering the restart complete.

Do not assume historical ComfyUI VRAM flags still exist on newer workers.

Retain the approved dynamic-VRAM-disabled mitigation on the dual-H100 workers unless deliberately retesting it.

**Why:** Model swapping is the reported PCIe-loss trigger; an isolated alternating H3/FLUX test passed with dynamic VRAM disabled, and the operator approved applying that option to all three workers. This does not prove the root cause or concurrent production stability.

**How to apply:** Preserve the mitigation during service changes. Check CLI support before ComfyUI upgrades: the installed build warns that the disable flag may be removed. Do not silently drop it or conflate it with CUDA allocator/offloading options.

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

Compare BMC and host clocks before correlating event times. Do not treat a successful guard check as a historical temperature sample.

**Why:** Inspection found the BMC clock five hours behind the host despite its UTC label. The guard does not retain healthy temperature readings, so its success cannot establish pre-failure temperature when thermal cutoffs are bypassed.

**How to apply:** Record both clocks in diagnostics and distinguish missing thermal evidence from evidence of normal temperatures. Capture the NVIDIA report before reboot clears the live crash state.

**Why:** Inspection on 2026-09-30 found a PCIe-slot critical-temperature event before fatal surprise-link-down errors on both GPU links. The supplied screenshot showed GPUs at 93°C/85°C with no compute processes, while the CPU was cool. GPU initialization failures and ECC messages after the link loss did not establish the original cause.

**How to apply:** Read BMC sensors/event logs and the first kernel error sequence, not just the final NVIDIA errors. Require adequate directed airflow and safe idle temperatures before any stress test; do not assume CPU-based chassis fan curves cool passive accelerators.

Verify an enforced power cap throughout a GPU test, not only the success message from setting it.

**Why:** On the dual-H100 host, a temporary 250 W setting was accepted but reverted to 350 W before CUDA load with persistence disabled. Temporarily enabling persistence kept the requested cap enforced. Without telemetry readback, the test would have been incorrectly reported as a lower-power test.

**How to apply:** Record original power limits and persistence state, keep GPU initialization alive during the test, and fail closed if the enforced limit rises. Restore both settings in cleanup and independently verify them afterward. A conservative test temperature cutoff is not the manufacturer's hardware-failure threshold.

Assess sustained real-workload temperature behavior separately from the earlier conservative benchmark cutoff.

**Why:** On 2026-10-01 the operator reported an hour of video generation with both H100s holding around 79°C at 250 W caps after disabling the custom cutoffs. This is user-reported sustained workload evidence, not an independently monitored stability certification. The earlier 70°C test abort should not be described as proof that these workloads cannot run.

**How to apply:** Retain that distinction when discussing cooling or operational readiness. Do not generalize the reported result to every workload or to memory temperatures, throttling, or output quality that were not measured.

Stable H100 temperatures near 79°C do not establish cooling headroom or unthrottled performance.

The operator reported installing additional fans on the first H100 on 2026-10-05. Do not assume this eliminated thermal throttling.

**Why:** Read-only monitoring during an existing render still detected NVIDIA software thermal slowdown as the first GPU warmed up, despite the additional fans. An initial cool sample had no thermal flags.

**How to apply:** Observe warm-up under the actual workload and compare thermal-counter deltas, not just the first sample. Distinguish thermal slowdown from the separate 250 W power cap; do not raise that cap as a cooling fix.

**Why:** Read-only monitoring on 2026-10-03 found both dual-H100 cards continuously busy but predominantly thermally throttled, even with power draw below their enforced 250 W caps. A steady temperature can reflect the driver reducing clocks to hold that temperature.

**How to apply:** Check live thermal and power-limit event reasons alongside clocks and power before recommending a higher cap. Address airflow first when thermal throttling dominates; neither clock ratios nor power-cap ratios directly measure render-time loss.
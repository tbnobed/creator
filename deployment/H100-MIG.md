# Dual-H100 CreatorAI MIG setup

## Applied host layout

The host has one `4g.40gb` and one `3g.40gb` instance per H100.
Actual NVIDIA MIG device ordering differs from the requested example:

| Physical GPU | MIG device index | Profile | Assignment | LAN endpoint |
|---|---|---|---|---|
| 0 | 1 | 4g.40gb | CreatorAI `obtv-comfy@0` | `http://192.168.203.4:8188` |
| 0 | 0 | 3g.40gb | CreatorAI `obtv-comfy@2` | `http://192.168.203.4:8190` |
| 1 | 1 | 4g.40gb | CreatorAI `obtv-comfy@1` | `http://192.168.203.4:8189` |
| 1 | 0 | 3g.40gb | Reserved for other internal AI services — never assign CreatorAI | None |

Each active endpoint reports approximately 39.5 GiB usable VRAM.
The reserved instance now serves internal language/embedding workloads.
Preserve its Docker services during CreatorAI worker changes.

## Startup and safety

- `/etc/nvidia-mig-parted/config.yaml` defines `obtv-split`.
- Enabled `mig-layout.service` applies the layout before all three ComfyUI
  services and Docker, after the existing power-limit service.
- `/usr/local/sbin/obtv-mig-comfy` resolves the assigned physical GPU UUID and
  profile on every worker start. It fails closed rather than falling back to
  a whole GPU or the reserved profile. This avoids depending on MIG UUID
  stability across reboots.
- Existing worker ports 8188 and 8189 retain their physical-GPU assignments.
- The third worker has a separate service account and writable data directories.
  Model files remain shared.
- All three services are enabled at boot. Boot ordering is configured, but no
  reboot was necessary or performed during this migration.
- Physical-GPU power remains 310 W per card. The watchdog retains ECC and
  missing-GPU checks and now stops all three CreatorAI workers on failure.
  The operator's existing custom-temperature-cutoff bypass remains unchanged.
- Temporary host ingress blocking on ports 8188–8190 was removed after checks.
  No router port-forwarding changes were made.

## Validation performed

Both queues drained before shutdown; no GPU compute processes remained before
MIG was applied. All three services then passed `/system_stats` checks and a
CUDA matrix calculation on their individual allowed slices. MIG layout
assertion and the existing safety precheck passed. The reserved slice received
no test workload. Full model renders and concurrent throughput were not tested.

## Live portal work remains

### Image-generation recurrence, 2026-10-27 22:18:28 UTC

**Supersedes the availability status in the reopening entry below.** GPU 0
again suffered fatal PCIe SDES at root port `c0:01.1`, Xid 79 at `c1:00.0`,
and failed link retraining. The driver requested a node reboot for both GPUs.
Worker 2 (GPU 0 3g slice, port 8190) accepted a FLUX Klein image prompt at
22:18:20; CUDA failed approximately eight seconds later at sampler-output
transfer. Startup logs confirmed native allocation and dynamic VRAM disabled.
The reopened worker logs contain no preceding H3 job; this occurrence is not
evidence that an H3-to-FLUX swap is required. No pre-failure temperature
time series was captured for this production job.

The watchdog stopped all three workers at 22:18:36. They remain inactive,
the recovery hold marker has been restored, and no recovery reboot has been
performed for this event. Internal Docker services still report healthy.
Private NVIDIA report (successful safe-mode capture), journals, and launcher:
`/var/backups/obtv-h100-recovery/20261027T221828Z/`.
The prior passing comparisons and allocator settings are not a demonstrated fix.

### Workers reopened, 2026-10-27 UTC

Following operator authorization, all three CreatorAI workers were brought
online and verified locally and externally on ports 8188–8190. The shared
launcher now uses both `--disable-dynamic-vram` and `--disable-cuda-malloc`,
matching the successful isolated comparisons. Each endpoint reports its
correct MIG profile and native allocator. Launch logs confirm the original
physical UUID/profile assignments; the reserved GPU 1 slice is untouched.
All workers are active and enabled at boot. Queues were empty at verification.

The recovery-hold marker was removed; its condition drop-in is retained so
future recovery can hold startup again. Temporary intake blocking was removed.
The existing host-wide watchdog policy, 310 W limits, MIG layout, and thermal
bypass remain unchanged. Other internal services report healthy, and no new
kernel GPU-loss errors were found during startup. This restores availability;
it does not establish that the intermittent PCIe fault is fixed.

Private pre-change launcher and hold configuration:
`/var/backups/obtv-h100-recovery/resume-20261027T220502Z/`.
Earlier stopped/held status entries below describe historical test phases.

### Previously failing 3g slice retest, 2026-10-25 UTC

On the same boot as the matching 4g comparison, GPU 0's 3g.40gb slice
passed the identical six-job full-resolution H3/FLUX sequence with dynamic
VRAM disabled and the native allocator. All three 124-frame 1280×736 videos
and three 1024×1024 images decoded successfully. Runtime was approximately
31 minutes. Kernel logs showed no new Xid/fatal PCIe errors; sampled
uncorrectable volatile ECC remained zero.

GPU 0 sampled peaks were 66°C core, 79°C memory, and 229.44 W; reported
power limit stayed at 310 W. These results do not establish a fix or a
3g-profile-specific cause: this profile and configuration have now both
failed and passed the same sequence across boots. All three allowed slices
passed sequentially on this boot, not concurrently or under an extended soak.

Private evidence:
`/var/backups/obtv-h100-recovery/gpu0-3g-comparison-20261025T181035Z/`.
Test overrides and temporary firewall rule were removed. All three video
workers remain stopped under the recovery hold. Other internal services
remain healthy. No reboot, shared allocator rollout, reserved-slice changes,
or production reopening occurred during this retest.

### Matching 4g slice comparison, 2026-10-25 UTC

After an authorized reboot, GPU 1's allowed 4g.40gb slice and then GPU 0's
4g.40gb slice each passed six alternating H3/FLUX jobs. The identical graphs
used H3 1280×736/124 frames/20 steps and FLUX 1024×1024/4 steps, with dynamic
VRAM and cudaMallocAsync disabled. All twelve outputs decoded successfully.
No new kernel Xid/fatal PCIe errors or uncorrectable volatile ECC were found.

Sampled peaks: GPU 1 67°C core/79°C memory/273.51 W; GPU 0 80°C core/
89°C memory/311.60 W. Reported power limits remained 310 W. GPU 0's higher
temperature merits attention but does not establish why earlier failures
occurred at lower sampled temperatures.

This does not demonstrate a fix: the prior failing full-resolution native-
allocator run used GPU 0's **3g.40gb**, not its 4g.40gb slice. Both physical
GPUs passing the matching 4g workload leaves intermittent hardware/path
faults and profile/workload-dependent driver behavior unresolved.

Private evidence:
`/var/backups/obtv-h100-recovery/matched-slices-20261025T164248Z/`.
Temporary overrides and intake-blocking rule were removed. All three video
workers remain stopped under the persistent recovery hold. Internal Docker
services are healthy; the reserved slice, MIG layout, 310 W limits, and
operator thermal policy were not changed. Native allocator remains a
diagnostic override, not a shared-launcher rollout.

### Full-resolution native-allocator failure, 2026-10-25 UTC

The isolated H3 1280×736 / FLUX 1024×1024 test failed on job three.
The first 124-frame H3 output and the following FLUX image completed and
decoded correctly. The second H3 job ran through sampling, loaded its
audio/video VAEs, then GPU 0 suffered fatal PCIe SDES/Xid 79 at 00:09:31 UTC.
The last healthy sample one second earlier was 63°C core, 75°C memory,
177.22 W, 310 W limit, zero uncorrectable volatile ECC. Whole-test peaks
were 66°C core and 78°C memory. The native allocator and dynamic-VRAM
disable flag were verified before submission; no other CreatorAI worker
was running.

The GSP history again showed a pending GSP_RM_ALLOC after completed FREE
requests. This is context, not proof that GSP caused the link loss.
Neither disabling dynamic VRAM nor adding the native allocator is a
demonstrated fix. The low-resolution swap and repeated-FLUX successes
do not establish production readiness.

Live NVIDIA report, test outputs, journals, configuration and telemetry:
`/var/backups/obtv-h100-recovery/20261025T000931Z/`.
All three video workers are stopped under the persistent recovery hold.
The temporary test override and firewall rule were removed. This crash was
subsequently recovered by the authorized reboot documented in the matching
slice comparison above; it is historical failure evidence, not current GPU
availability.

### Native allocator test, 2026-10-24

After an authorized recovery reboot, worker 8190 alone ran with both
`--disable-dynamic-vram` and `--disable-cuda-malloc`. The API verified the
allocator as `native`; two-stream offloading and pinned memory were unchanged.
Fifty 1024×1024 FLUX jobs completed over approximately eleven minutes,
including nine one-minute idle intervals. All fifty output PNGs decoded.
GPU 0 sampled peaks: 53°C core, 65°C memory, 268.08 W. The power limit
remained 310 W, uncorrectable volatile ECC remained zero on both GPUs,
and no kernel Xid/PCIe errors appeared, including after worker shutdown.

This is a promising isolated same-model result, not a full-resolution
H3/FLUX switching test, concurrent test, or established root cause.
Private evidence:
`/var/backups/obtv-h100-recovery/allocator-test-20261024/`.

The test override and temporary network rule have been removed. All three
video workers are stopped under `/etc/obtv/h100-recovery-hold` and its
`99-recovery-hold.conf` start condition. Other internal services are healthy.
The native allocator has **not** been rolled out to the shared launcher.

### Model-swapping diagnostic, 2026-10-24

**Superseded by recurrence at 22:58:51 UTC:** GPU 0 again reported PCIe
SDES/Xid 79 with dynamic VRAM disabled. The watchdog stopped all three
video workers; no recovery reboot has been performed for this recurrence.
Worker 8190 completed four FLUX jobs before the next prompt failed at
sampler-output transfer, without a new model-load message. Workers 8188
and 8189 showed no render activity in that interval. The last successful
image was 1024×1024, unlike the 640×384 diagnostic. CUDA errors are
asynchronous, so the transfer traceback does not identify the initiating
fault. Other internal services still reported healthy.

The live NVIDIA crash report and journals are preserved privately at
`/var/backups/obtv-h100-recovery/20261024T225851Z/`.
The previous successful rollout checks below are historical, not current
availability or stability claims.

After another GPU 0 PCIe surprise-down/Xid 79 event, an authorized reboot
and isolated test on worker 2 completed six alternating H3/FLUX jobs
(five model-family transitions) with only `--disable-dynamic-vram` added.
cudaMallocAsync and two-stream asynchronous offloading remained enabled.
All three 124-frame videos and three images decoded at 640×384.
Sampled GPU 0 peaks were 63°C core and 76°C memory, with zero reported
uncorrectable volatile ECC errors and no new kernel Xid/PCIe errors.
This is a bounded mitigation test, not proof of root cause or full-resolution,
concurrent stability.

Private evidence: `/var/backups/obtv-h100-recovery/swap-test-dynamic-disabled/`.
Temporary worker override and network blocking were removed after the queue
drained. Following operator approval, the shared MIG launcher was updated
to pass `--disable-dynamic-vram` for all three video workers; the recovery
hold and its drop-in were removed. All three workers are active and enabled
at boot. Local and external `/system_stats` checks verified the flag and
correct MIG profiles on ports 8188–8190. Other internal services remain
healthy, power remains 310 W, and no new kernel Xid/PCIe errors were found.
The pre-rollout launcher is preserved beside the private diagnostic evidence.
Do not treat this test as authorization to change MIG, firmware, power, or
the operator-controlled thermal bypass.

### Recovery verification, 2026-10-07

After GPU 0 reported Xid 79 and fatal PCIe link loss, an authorized host reboot
restored both GPUs and the expected four MIG instances. Worker startup was held
across reboot, then all three services were verified before intake was restored.
GPU 0 passed an isolated 30-second CUDA matrix workload at 29–32°C without a
new PCIe error or thermal slowdown. This was a limited recovery check, not a
full video render or proof that the underlying fault is fixed.

Failure evidence is preserved privately at
`/var/backups/obtv-h100-recovery/20261007T215045Z/`.
The affected worker's saved log shows H3 completion at 21:43:29 UTC,
LTX loading at 21:47:37, a latent-upscaler load at 21:48:19, and PCIe failure
at 21:48:22. That establishes timing, not the root cause.

### Portal configuration status

The workspace database did not contain the dual-H100 worker records, and the
operator did not identify the live portal/database. Its worker records were
therefore not changed. Do not interpret host setup as completed portal migration.

Once the actual portal is accessible:

1. Back up its GPU Server settings and application Compose/env configuration
   privately. Those application-host files were not available for the host backup.
2. Update the existing two worker records to their 4g profiles and retain their
   IDs/history. Add only the GPU 0 3g worker on port 8190. Never add the reserved
   GPU 1 3g instance to the worker pool.
3. Use URLs reachable from that API server. The LAN addresses above are not
   necessarily reachable from Replit or through existing router forwards.
4. Set maximum concurrency to one per slice initially. Remove any 80 GB
   assumptions and grant model tags only after verifying model/node availability
   and successful representative renders within the 40 GB slice.
5. Deploy the memory-telemetry compatibility fix in `comfy-device-memory.ts`;
   both scheduled health checks and the Test Connection endpoint now read
   `vram_total` / `vram_free`, with support for legacy field names.

## Rollback

Private timestamped host snapshots are beneath the SSH operator's
`~/mig-migration/before/`. They contain original unit files, env files, guard,
telemetry, process inventories, and a pre-migration firewall snapshot.

Rollback requires an intentional maintenance window. Pause intake, drain all
three CreatorAI workers, then stop them. Do **not** destroy MIG instances or
disable MIG if another service has begun using the reserved slice: obtain its
operator's approval first. With all GPU clients stopped, restore the backed-up
units/env/guard, remove the MIG startup override and new third-worker service,
and revert the MIG layout using supported NVIDIA commands. Revalidate GPU
assignments, power/guard settings and endpoints before reopening intake.
Do not overwrite unrelated later firewall changes with an old full snapshot.

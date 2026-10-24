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

### Model-swapping diagnostic, 2026-10-24

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

# Dual-H100 local render validation — 2026-10-01

## Decision: do not enable automatic jobs

**Controlled execution and short-duration thermal checks passed. Visual output quality failed.** Both workers produced decodable videos, but inspected frames are severely oversaturated, distorted and fragmented at both 8 and 20 sampling steps. The cause is not established. A successful ComfyUI history entry is not a production-readiness pass.

No cooling cutoff occurred. This is not evidence of sustained cooling capacity, normal-resolution video quality, or compatibility with other model families.

## Configuration and preflight

- Checked 20:21–20:26 UTC, on the separate dual-H100 host identified in `replit.md`.
- Physical GPUs: NVIDIA H100 PCIe; GPU 0 UUID ending `73778ddf`, GPU 1 ending `59f4`. Service environment assignments match these physical devices.
- Existing `/opt/obtv/venv`, ComfyUI 0.38.0, PyTorch 2.9.1+cu130, NVIDIA driver 580.178.04. No packages, models, service flags, fan settings, or runtime configuration changed.
- Both queues empty before each stage. Workers remained running but disabled for boot, listening exclusively on `127.0.0.1:8188` and `127.0.0.1:8189`.
- Both GPUs: requested and **enforced** limits 250 W, persistence Enabled, volatile uncorrectable ECC 0. Verified before, throughout, and after testing.
- Existing safety timer remained enabled and active. Its live guard retained GPU ≥70°C, memory ≥80°C, enforced limit >250 W, missing/unreadable GPU telemetry, and uncorrectable ECC stop conditions.
- Additional test supervisor sampled telemetry approximately once per second, stopped both services on the same unsafe conditions, and imposed a 180-second per-stage render watchdog. No stop was triggered.
- Preflight BMC PCIe temperatures were 45–46°C; no new BMC events appeared during the test. Historical September 30 critical-temperature events remain in the event log and were not cleared. No new Xid, GPU disappearance, or PCIe error messages appeared in the current test window.

## Workflow and installed-file verification

Source: `artifacts/api-server/src/lib/seed-data/wan-22.ts`, `createWan22T2vWorkflow()`.

Verified all 12 required node classes in each worker's `/object_info`, including `ComfyMathExpression`, `Wan22ImageToVideoLatent`, `CreateVideo`, and `SaveVideo`. Verified selectable filenames and actual non-empty files under `/opt/obtv/ComfyUI/models` (resolving into `/srv/obtv/models`):

| Model | Bytes |
|---|---:|
| `wan2.2_ti2v_5B_fp16.safetensors` | 9,999,658,848 |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6,735,906,897 |
| `wan2.2_vae.safetensors` | 1,409,400,960 |

Safetensors headers parsed successfully and their declared data extents matched file lengths. This checks file layout/truncation, not authenticity against an upstream checksum. Actual inference loaded the selected files without exceptions.

The graph was exported directly from the existing seed, not recreated:

- Resolution reduced from 1280×704 to **512×288**.
- Requested frame input reduced from 120 to 16, yielding **17 frames at 24 fps** through the seed's existing expression (~0.71 seconds).
- First pass used **8 steps**; a second controlled pass restored the seed's **20 steps** after visual inspection failed.
- Original CFG 5, `uni_pc`, `simple`, shift 8, denoise 1, VAE, models, video output nodes, and negative prompt retained.
- Prompt: “A red ceramic teapot on a wooden table in soft daylight. The camera slowly moves to the right. Sharp detail, natural colors.”
- Unique test-only output prefixes and deterministic seeds were used. Exact submitted seed values/prefixes are recoverable from the archived execution log/telemetry and the test recipe below.
- Start gate: both cards ≤55°C GPU / ≤65°C memory. Concurrent stages permitted only after both individual runs completed with observed peaks ≤60°C GPU / ≤70°C memory.

## Measured results

Temperatures and power draw are **sampled maxima**, not guaranteed instantaneous maxima. Elapsed times include polling/output decoding. Concurrent jobs overlapped according to ComfyUI execution timestamps; the 20-step concurrent run also sampled simultaneous 98%/96% GPU utilization.

| Steps | Stage | Elapsed | GPU 0 peak GPU / memory | GPU 1 peak GPU / memory | Peak observed draw GPU 0 / 1 |
|---|---|---:|---|---|---|
| 8 | Worker 8188 alone | 6.40 s | 52 / 62°C | 46 / 61°C (idle) | 165.48 / 83.21 W |
| 8 | Worker 8189 alone | 3.14 s | 47 / 61°C (idle) | 54 / 64°C | 127.71 / 159.67 W |
| 8 | Both workers | 1.10 s | 49 / 62°C | 50 / 64°C | 211.22 / 208.73 W |
| 20 | Worker 8188 alone | 2.14 s | 54 / 64°C | 46 / 61°C (idle) | 257.99 / 83.33 W |
| 20 | Worker 8189 alone | 2.11 s | 48 / 61°C (idle) | 55 / 65°C | 139.59 / 258.78 W |
| 20 | Both workers | 2.14 s | 54 / 65°C | 56 / 66°C | 262.21 / 257.80 W |

**Power distinction:** every reported `power.limit` and `enforced.power.limit` remained 250 W. Some `power.draw` samples exceeded 250 W, up to 262.21 W. These are observed draw readings, not evidence that the enforced-limit setting changed. They are recorded rather than hidden; this test does not claim a hard instantaneous ≤250 W draw. The existing policy checks the enforced limit, not draw, and was not changed.

No ComfyUI execution exceptions, guard cutoffs, or volatile uncorrectable ECC errors were observed. All eight histories reported success. Later runs reused model/text/latent caches, but seeds changed and the sampler, VAE decode, and video-output nodes executed; logs show 8/8 and 20/20 sampler progress.

## Output integrity and quality

- All **eight MP4s** decoded fully using PyAV: exactly 17 RGB frames, 512×288, 24 fps, nonzero per-frame variance, nonblack/nonwhite frames.
- Output sizes: 153,771–225,451 bytes. Individual SHA-256 hashes and decoded statistics are recorded in the telemetry JSON.
- **Visual quality failed:** first-frame inspection on both individual workers at both step counts showed severe color and structure distortion. See the four JPEGs beside this report. Increasing steps did not resolve it.
- Codec/frame-count checks therefore passed; visual acceptance did not. No claim is made that model weights are semantically correct or that the reduced dimensions are suitable for this model.
- No speech, audio, reference-image path, MiniMax, or normal-resolution sustained generation was validated.

## Cleanup and final state

At 20:26:18 UTC:

- All eight owned prompt-history entries removed individually by prompt ID. No queue/history-wide clear or unrelated interrupt used.
- All eight test MP4s and remote temporary scripts, reports, graphs, and JPEG previews removed. Local evidence retained here.
- Both queues empty. Original ComfyUI processes remained running; no worker restart performed.
- Both listeners still localhost-only; both ComfyUI units still disabled for boot.
- Final GPU/memory temperatures: GPU 0 **46/60°C**, GPU 1 **47/60°C**.
- Both requested/enforced limits **250 W**, persistence Enabled, ECC 0; power service and guard timer remain active/enabled.
- No app/database dispatch configuration, worker capability tags, network exposure, paid provider calls, or power/thermal policy changes.

## Evidence and interpretation

- `telemetry.json`: first 8-step run, full timestamped samples and completion metadata.
- `telemetry-20-steps.json`: 20-step repeat.
- `workflow-8-steps.json`, `workflow-20-steps.json`: graphs exported from the seed before per-job seed/prefix substitution.
- `worker{0,1}-{8,20}-steps.jpg`: inspected first-frame evidence.
- `cleanup-and-worker-log.txt`: sampler/model-load logs, exact cleanup IDs, final queue/service/port/power state, and error checks. The `GUARD_ERRORS` section includes routine messages because the service description contains “unsafe”; these are successful checks, not actual safety-stop events.

The supervisor's original `result: short_render_validation_passed` records mechanical execution/decoding only. The separately added `visual_quality_result` and `readiness` fields capture the subsequent manual image inspection. **Use this report's failed visual acceptance as the overall readiness decision.**

Reproduction recipe (requires fresh authorization and the same safety preflight): export the seed graph, apply the recorded resolution/frame/step/prompt overrides, then for stage index 1/2/3 use seed `2026100100 + port + stageIndex * 100`, save under a unique test-only prefix, and test 8188 alone, 8189 alone, then both only with headroom. Do not run a larger or longer workload until output corruption is understood.

## Recommended next work

1. Diagnose the shared Wan output distortion without changing safety limits or exposing workers. Check supported dimensions, model/VAE pairing and verified upstream file checksums, then perform a bounded known-good comparison.
2. Once visual correctness is established, separately authorize normal-resolution and longer-duration thermal validation. These sub-second clips cannot qualify sustained simultaneous production use.
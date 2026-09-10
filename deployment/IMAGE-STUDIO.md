# Image Studio

Image Studio is an independent, tenant-private workspace for photographers and graphic artists. It does not require a Character, Scene, or video project.

## Providers

- **Your GPUs** runs compatible ComfyUI workflows on configured workers. These models have no per-image Cloud charge; operating the GPU still costs money.
- **Cloud** uses the existing server-side provider credentials. The browser never receives credentials. Users must explicitly confirm Cloud charges before submitting a job.
- Missing or busy local workers never trigger a paid fallback.
- The public model catalog advertises supported operations and price notes. Not every model supports editing, masks, reference images, seeds, or negative prompts. Prices are estimates, not billing guarantees.

All UI copy, public errors, toasts, and progress messages must use **Cloud**, not the underlying provider's name. Internal environment variable names and provider endpoints remain unchanged.

## Local model readiness

Image Studio validates the worker's installed node definitions and model filenames before declaring a local model available. A healthy GPU alone is not sufficient.

The local model lineup is:

| Model | Commercial self-hosting license | Intended use |
| --- | --- | --- |
| FLUX.2 klein **4B** | Apache 2.0 | Fast generation |
| Qwen-Image-2512 | Apache 2.0 | Detailed generation and typography |
| Z-Image Turbo | Apache 2.0 | Efficient drafts and photorealistic generation |

Do not substitute FLUX 9B or dev weights without reviewing their separate licenses.

Use the existing GPU Servers administration to configure workers. Install the appropriate ComfyUI-compatible diffusion model, text encoder, and VAE on the worker, then assign the model's capability tag. Do not restart an occupied worker or replace its Python/Torch environment to install an image model. Preserve existing video and voice workflows.

The adapter's model-file checks are the source of truth for supported filenames. Models that are not installed remain unavailable in the UI.

### Reproducible worker installation

SSH connection details are recorded under **GPU worker access** in `replit.md`.
Copy `scripts/provision-image-studio-models.py` to the worker, then run it as
the owner of the model directory:

```bash
# A100 worker (SSH port 225)
python3 /tmp/obtv-provision-image-models.py --models-dir /home/ubuntu/ComfyUI/models

# H100-labeled worker (SSH port 226)
sudo -u comfyui python3 /tmp/obtv-provision-image-models.py --models-dir /srv/comfyui/models
```

The installer uses pinned official Comfy-Org model revisions and verifies
SHA-256 checksums for every file, including files already installed. Downloads
resume from `.part` files; `aria2c` is used when available, with `curl` as the
fallback. It neither updates ComfyUI/Python nor restarts services, and refuses
to overwrite existing files that differ from upstream.

After installation, run the real application adapter checks from this project:

```bash
node scripts/test-image-worker-models.mjs --api-url http://107.180.212.240:8181/
node scripts/test-image-worker-models.mjs --api-url http://107.180.212.240:8182/
```

Each command reserves only its selected development worker, refuses occupied
queues, generates one image with each local model, checks output dimensions,
and restores the worker's prior enabled setting. It never submits paid Cloud
work. On uncertain cancellation, it leaves the worker disabled and prints
recovery instructions instead of exposing an occupied GPU to new app jobs.
Assign the capability tags below only after those checks pass.

| Capability tag | Diffusion model | Text encoder | VAE |
| --- | --- | --- | --- |
| `flux2-klein` | `flux-2-klein-4b.safetensors` | `qwen_3_4b.safetensors` | `flux2-vae.safetensors` |
| `qwen-image-2512` | `qwen_image_2512_fp8_e4m3fn.safetensors` | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `qwen_image_vae.safetensors` |
| `z-image-turbo` | `z_image_turbo_bf16.safetensors` | `qwen_3_4b.safetensors` | `ae.safetensors` |

Use the official [FLUX.2 klein](https://docs.comfy.org/tutorials/flux/flux-2-klein), [Qwen-Image-2512](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2512), and [Z-Image Turbo](https://docs.comfy.org/tutorials/image/z-image/z-image-turbo) installation instructions for the matching ComfyUI weight distributions and directories.

Source model cards:

- https://bfl.ai/models/flux-2-klein
- https://huggingface.co/Qwen/Qwen-Image-2512
- https://huggingface.co/Tongyi-MAI/Z-Image-Turbo

## Storage and upgrades

Image Studio uses the existing `OBTV_MEDIA_ROOT` volume for uploads and generated images, with metadata and job state in PostgreSQL. Back up both the database and media volume. The additive Image Studio migration is included in the normal migration sequence; use the existing deployment upgrade process.

Queued provider request IDs and monitoring metadata are persisted so an API restart does not intentionally resubmit a paid generation. Cancellation is best effort upstream: cancelling after a provider has started may still incur a charge.

## Verification

Run the development server and database migrations first:

```sh
node scripts/test-image-studio.mjs
```

The regression test creates isolated test tenants, verifies API authorization and gallery persistence, checks desktop/mobile rendering, and removes its fixtures afterward. It does not submit Cloud jobs.

Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when the development environment provides its own Chromium executable instead of Playwright's downloaded browser.

To additionally test a real local generation on an available GPU:

```sh
IMAGE_STUDIO_TEST_RENDER=1 node scripts/test-image-studio.mjs
```

This optional test consumes local GPU capacity. Do not run it during an occupied worker's maintenance or active production render.
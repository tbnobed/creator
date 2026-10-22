# Blackwell worker installation

## Current hardware verification — 2026-10-22

The host at `192.168.201.221` now exposes **two RTX 5090 workers**, on
ports 8188 and 8189. Both were reached over the internal network from the
dual-H100 SSH host. The older 6000/5090 installation notes below are historical,
not a description of the current GPU pair.

Both running ComfyUI instances report version 0.35.0 and advertise:
- `MiniMaxH3ImageToVideo` (native first-frame conditioning)
- `minimax_h3_fl2va_pruned_nvfp4.safetensors`
- `minimax_h3_ref2va_pruned_nvfp4.safetensors`
- `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
- MiniMax H3 video and audio VAEs

Both queues were empty at inspection. No software upgrades, restarts or renders
were performed: the required node and model files were already present.
File/node availability is not a completed render or a 32 GB memory qualification.
Include **both workers** in the exact-first-frame production integration and
validate each before assigning that capability. The missing application
approved-frame/FL2VA pipeline is separate from model installation.

## Historical installation notes

- Existing RTX PRO 6000 (96 GB): `comfyui.service`, port 8188. Existing input, output and user folders were preserved.
- RTX 5090 (32 GB): `obtv-comfy-secondary.service`, port 8189 on all IPv4 interfaces. Separate folders under `/srv/comfyui/5090`.
- Both services are enabled at boot.
- Shared models: `/srv/comfyui/models`, linked by `/opt/ComfyUI/models`.
- Shared runtime: `/opt/ComfyUI/venv`.
- GGUF dependency overlay: `/srv/comfyui/obtv-deps`; both services receive this through `PYTHONPATH`.
- The secondary service reads its physical GPU UUID from `/etc/obtv-secondary-gpu`.

The operator requested network access without a source-IP allowlist limited to the OBTV API host. No source-IP allowlist or router forwarding was added. Do not expose either unauthenticated ComfyUI port to the public internet without an authenticated gateway or private network. Deployed application registration is not verified.

LAN endpoints:
- RTX PRO 6000: `http://192.168.201.221:8188`
- RTX 5090: `http://192.168.201.221:8189`

The operator identified the OBTV API host as `192.168.3.27`. The GPU host routes to that subnet through its existing gateway. This is not evidence of reachability in the reverse direction from the API host.

## Installed model families

Flux 2 Klein 4B, Qwen Image 2512, Z-Image Turbo, Wan 2.2 TI2V 5B, LTX 2.5 Q6_K, Wan 2.1 VACE 14B, SAM 3.1, and their supporting encoders/VAEs. Existing MiniMax H3 reference/first-last models, encoders, VAEs and LoRAs were preserved.

LTX's encoder required the existing Hugging Face credential. It was passed over SSH stdin and used in curl's stdin configuration, not written into commands, units or this document.

## Qualification

- RTX 5090: Flux, Z-Image and Qwen generated recognizable teapot images; each image was inspected.
- RTX PRO 6000: Wan rendered 17 frames at 1280×704; sampled beginning/middle/end frames were inspected.
- RTX PRO 6000: LTX rendered 25 frames at 768×512 with an AAC audio stream; sampled frames were inspected. Audio stream presence does not establish audio perceptual quality.
- Wan's otherwise identical 512×288 test rendered corrupted imagery. Do not use that test resolution as a valid Wan configuration.
- Both endpoints advertised the installed model filenames, GGUF loader, and garment tracking/VACE nodes.
- VACE/SAM files passed checksum verification, but garment rendering was not visually qualified on this host.
- MiniMax was already running an operator job on arrival. It was left uninterrupted; no new MiniMax quality claim is made.
- These short tests do not establish sustained-load performance or every model/GPU combination.

The 5090 is intended for the tested image workloads and the larger 6000 for the tested video workloads. A shared model library does not prove each model runs within both GPUs' memory budgets.

## Operational checks

Inspect each worker's `/queue` before any restart. Prefer systemd over reconstructing processes manually. The installed ComfyUI version rejects the historical `--normalvram` flag; the secondary service uses the default memory policy.

The deployment still needs connectivity verification from the actual OBTV API host, followed by registration and end-to-end app verification. Do not substitute development-database registration for that verification.
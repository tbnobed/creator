# Blackwell worker installation

## Services

- Existing RTX PRO 6000 (96 GB): `comfyui.service`, port 8188. Existing input, output and user folders were preserved.
- RTX 5090 (32 GB): `obtv-comfy-secondary.service`, loopback port 8189. Separate folders under `/srv/comfyui/5090`.
- Both services are enabled at boot.
- Shared models: `/srv/comfyui/models`, linked by `/opt/ComfyUI/models`.
- Shared runtime: `/opt/ComfyUI/venv`.
- GGUF dependency overlay: `/srv/comfyui/obtv-deps`; both services receive this through `PYTHONPATH`.
- The secondary service reads its physical GPU UUID from `/etc/obtv-secondary-gpu`.

Do not open the secondary port to the public internet without an authenticated gateway or private network. It is not yet registered in the deployed OBTV application.

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

The deployment still needs a private/authenticated route from the actual OBTV API host to the secondary service, followed by registration and end-to-end app verification. Do not substitute development-database registration for that verification.
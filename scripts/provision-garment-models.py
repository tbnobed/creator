#!/usr/bin/env python3
"""Install pinned garment-editing weights without modifying or restarting ComfyUI.

Run on the GPU host with write permission to its shared model directory.
Existing files are verified, not blindly replaced. Interrupted downloads resume.
"""
import argparse
import hashlib
import os
import pathlib
import subprocess

MODELS = [
    ("diffusion_models/wan2.1_vace_14B_fp16.safetensors",
     "Comfy-Org/Wan_2.1_ComfyUI_repackaged", "123acf1cc74bccbb9bfff8ac1ee72edc08c2341d",
     "split_files/diffusion_models/wan2.1_vace_14B_fp16.safetensors",
     "f202a5c59b8a91ada1862c46a038214f1f7f216c61ec8350d25f69b919da4307"),
    ("vae/wan_2.1_vae.safetensors",
     "Comfy-Org/Wan_2.1_ComfyUI_repackaged", "123acf1cc74bccbb9bfff8ac1ee72edc08c2341d",
     "split_files/vae/wan_2.1_vae.safetensors",
     "2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b"),
    ("checkpoints/sam3.1_multiplex_fp16.safetensors",
     "Comfy-Org/sam3.1", "7bb8374780a725b4353ed31f3a9395c9742b5621",
     "checkpoints/sam3.1_multiplex_fp16.safetensors",
     "9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03"),
]


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()
    for relative, repo, revision, remote, expected in MODELS:
        destination = pathlib.Path(args.models_dir) / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            if digest(destination) != expected:
                raise RuntimeError(f"Existing model checksum mismatch: {destination}; refusing replacement")
            print(f"Verified existing {relative}", flush=True)
            continue
        temporary = destination.with_suffix(".safetensors.partial")
        print(f"Downloading {relative}", flush=True)
        subprocess.run([
            "curl", "--fail", "--location", "--retry", "5", "--retry-delay", "10",
            "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "120",
            "--continue-at", "-", "--output", str(temporary), "--silent", "--show-error",
            f"https://huggingface.co/{repo}/resolve/{revision}/{remote}",
        ], check=True)
        if digest(temporary) != expected:
            raise RuntimeError(f"Downloaded checksum mismatch: {temporary}")
        os.chmod(temporary, 0o644)
        os.replace(temporary, destination)
        print(f"Installed and verified {relative}", flush=True)
    print("All garment model files verified. No services restarted.", flush=True)


if __name__ == "__main__":
    main()
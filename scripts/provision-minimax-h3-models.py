#!/usr/bin/env python3
"""Install the five Hopper-compatible MiniMax H3 workflow files, verified against pinned LFS SHA-256."""
import argparse
import concurrent.futures
import json
from pathlib import Path
import runpy
import shutil
import urllib.request


REPO = "Comfy-Org/MiniMax-H3"
REVISION = "e5eb578a89295337b8ff433a035929ce0279e0b6"
PATHS = (
    "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    "text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    "vae/minimax_h3_video_vae_fp16.safetensors",
    "vae/minimax_h3_audio_vae_fp32.safetensors",
    "loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-dir", type=Path, required=True)
    args = parser.parse_args()
    if not args.models_dir.is_dir():
        parser.error("models directory must already exist")
    installer = runpy.run_path(str(Path(__file__).with_name("provision-image-studio-models.py")))
    url = f"https://huggingface.co/api/models/{REPO}/tree/{REVISION}?recursive=true&limit=1000"
    with urllib.request.urlopen(url, timeout=60) as response:
        rows = {entry["path"]: entry for entry in json.load(response)}
    entries = []
    for relative in PATHS:
        row = rows[relative]
        digest = row["lfs"]["oid"]
        if len(digest) != 64:
            raise RuntimeError(f"No upstream SHA-256 for {relative}")
        entries.append({
            "path": relative,
            "size": row["size"],
            "sha256": digest,
            "url": f"https://huggingface.co/{REPO}/resolve/{REVISION}/{relative}",
        })
    missing = sum(entry["size"] for entry in entries if not (args.models_dir / entry["path"]).exists())
    free = shutil.disk_usage(args.models_dir).free
    if free < missing + 5 * 1024 ** 3:
        raise RuntimeError(f"Insufficient space: need {missing / 1e9:.1f} GB plus 5 GiB reserve")
    print(f"MiniMax H3: {missing / 1e9:.2f} GB missing; {free / 1e9:.2f} GB free", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        list(executor.map(lambda entry: installer["install"](args.models_dir, entry), entries))
    print("ALL MINIMAX H3 FILES VERIFIED.", flush=True)


if __name__ == "__main__":
    main()
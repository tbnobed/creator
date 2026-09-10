#!/usr/bin/env python3
"""Install pinned Image Studio weights without changing ComfyUI or Python.

Run on a GPU worker as the owner of its models directory:
  python3 provision-image-studio-models.py --models-dir /path/to/ComfyUI/models

Public upstream downloads only. Existing files must match upstream checksums;
unknown files are never overwritten. Interrupted downloads resume from .part.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request


SOURCES = [
    ("Comfy-Org/flux2-klein", "5f526678002e43af5551dadb73ce2e8c91b43afe", [
        "diffusion_models/flux-2-klein-4b.safetensors",
        "text_encoders/qwen_3_4b.safetensors",
    ]),
    ("Comfy-Org/flux2-dev", "ab9055628ea245000e610f2aa2c96f4746093546", [
        "vae/flux2-vae.safetensors",
    ]),
    ("Comfy-Org/Qwen-Image_ComfyUI", "7beb7b647f04469fbe64ba8adc2bb0d7e5e9f73f", [
        "diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors",
        "text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
        "vae/qwen_image_vae.safetensors",
    ]),
    ("Comfy-Org/z_image_turbo", "08d04455279082882deaabc8d0d09fc914c071e1", [
        "diffusion_models/z_image_turbo_bf16.safetensors",
        "vae/ae.safetensors",
    ]),
]


def manifest():
    result = []
    for repo, revision, paths in SOURCES:
        url = f"https://huggingface.co/api/models/{repo}/tree/{revision}?recursive=true"
        with urllib.request.urlopen(url, timeout=60) as response:
            rows = {entry["path"]: entry for entry in json.load(response)}
        for relative in paths:
            remote = f"split_files/{relative}"
            entry = rows[remote]
            digest = entry["lfs"]["oid"]
            if len(digest) != 64:
                raise RuntimeError(f"No SHA-256 digest for {relative}")
            result.append({
                "path": relative,
                "size": entry["size"],
                "sha256": digest,
                "url": f"https://huggingface.co/{repo}/resolve/{revision}/{remote}",
            })
    return result


def valid(path, entry):
    if path.stat().st_size != entry["size"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == entry["sha256"]


def install(root, entry):
    target = root / entry["path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if not valid(target, entry):
            raise RuntimeError(f"Existing file differs from pinned upstream; not overwriting: {target}")
        print(f"VERIFIED existing {entry['path']}", flush=True)
        return
    temporary = target.with_suffix(target.suffix + ".part")
    print(f"DOWNLOADING {entry['path']} ({entry['size'] / 1e9:.2f} GB)", flush=True)
    # Parallel ranges avoid throttling of a single large upstream transfer.
    # Both downloaders resume partial files; only public URLs are arguments.
    command = [
        "curl", "--fail", "--location", "--silent", "--show-error",
        "--retry", "5", "--retry-delay", "3", "--connect-timeout", "30",
        "--speed-limit", "1024", "--speed-time", "120", "--max-time", "5400",
        "--continue-at", "-", "--output", str(temporary), entry["url"],
    ]
    if shutil.which("aria2c"):
        command = [
            "aria2c", "--continue=true", "--max-connection-per-server=8",
            "--split=8", "--min-split-size=4M", "--file-allocation=none",
            "--auto-file-renaming=false", "--allow-overwrite=true",
            "--max-tries=5", "--retry-wait=3", "--connect-timeout=30", "--timeout=120",
            "--console-log-level=warn", "--summary-interval=0",
            "--download-result=hide", "--dir", str(temporary.parent),
            "--out", temporary.name, entry["url"],
        ]
    # Redirect responses can contain expiring signed URLs. Do not log them.
    outcome = subprocess.run(command, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if outcome.returncode:
        raise RuntimeError(f"Download failed for {entry['path']} ({command[0]} {outcome.returncode}); .part retained")
    if not valid(temporary, entry):
        raise RuntimeError(f"Checksum mismatch for {entry['path']}; .part retained for inspection")
    os.chmod(temporary, 0o644)
    os.replace(temporary, target)
    print(f"INSTALLED {entry['path']} SHA256 verified", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-dir", type=Path, required=True)
    parser.add_argument("--parallel", type=int, default=3, choices=range(1, 5))
    args = parser.parse_args()
    if not args.models_dir.is_dir():
        parser.error("models directory must already exist")
    if not shutil.which("curl"):
        parser.error("curl is required")
    entries = manifest()
    missing = sum(
        entry["size"] for entry in entries
        if not (args.models_dir / entry["path"]).exists()
    )
    free = shutil.disk_usage(args.models_dir).free
    if free < missing + 5 * 1024 ** 3:
        raise RuntimeError(f"Insufficient free space: need {missing / 1e9:.1f} GB plus 5 GiB reserve")
    print(f"Missing downloads: {missing / 1e9:.2f} GB; free: {free / 1e9:.2f} GB", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel) as executor:
        list(executor.map(lambda entry: install(args.models_dir, entry), entries))
    print("ALL IMAGE STUDIO MODEL FILES VERIFIED. No service or environment was changed.", flush=True)


if __name__ == "__main__":
    main()
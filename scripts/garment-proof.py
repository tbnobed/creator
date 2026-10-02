#!/usr/bin/env python3
"""Short local garment-replacement feasibility test, not a production batch runner.

Uses the official ComfyUI VACE conditioning graph plus SAM3 video tracking.
Never interrupts, clears a queue, restarts workers, or calls cloud providers.
"""
import argparse
import json
import pathlib
import time
import urllib.request
import uuid


def workflow(filename, prefix, prompt, seed=421, reference=None, target=None):
    if not target or not target.strip():
        raise ValueError("Identify the garment to edit.")
    graph = {}

    def node(key, kind, **inputs):
        graph[str(key)] = {"class_type": kind, "inputs": inputs}
        return [str(key), 0]

    video = node(1, "LoadVideo", file=filename)
    frames = node(2, "GetVideoComponents", video=video)
    sam = node(3, "CheckpointLoaderSimple", ckpt_name="sam3.1_multiplex_fp16.safetensors")
    shirt = node(4, "CLIPTextEncode", clip=["3", 1], text=target)
    track = node(5, "SAM3_VideoTrack", images=frames, model=sam,
                 conditioning=shirt, detection_threshold=0.5, max_objects=1, detect_interval=1)
    mask = node(6, "SAM3_TrackToMask", track_data=track, object_indices="0")
    # Preserve the mask as a diagnostic output before judging rendered quality.
    mask_image = node(7, "MaskToImage", mask=mask)
    mask_video = node(8, "CreateVideo", images=mask_image, fps=16)
    node(9, "SaveVideo", video=mask_video, filename_prefix=f"{prefix}/mask", format="mp4",
         **{"format.codec": "h264", "format.codec.encoding": "auto"})
    # Match the official inpainting blueprint: erase the edit region first.
    # Passing the original pixels as reactive conditioning preserves the old garment.
    inverse_mask = node(24, "InvertMask", mask=mask)
    blank_region = node(25, "MaskToImage", mask=inverse_mask)
    control = node(26, "ImageCompositeMasked", destination=frames, source=blank_region,
                   x=0, y=0, resize_source=False, mask=mask)
    model = node(10, "UNETLoader", unet_name="wan2.1_vace_14B_fp16.safetensors", weight_dtype="fp8_e4m3fn")
    model = node(11, "ModelSamplingSD3", model=model, shift=5)
    clip = node(12, "CLIPLoader", clip_name="umt5_xxl_fp8_e4m3fn_scaled.safetensors", type="wan")
    vae = node(13, "VAELoader", vae_name="wan_2.1_vae.safetensors")
    positive = node(14, "CLIPTextEncode", clip=clip, text=prompt)
    negative = node(15, "CLIPTextEncode", clip=clip,
                    text="flicker, distorted clothing, extra limbs, changed face, changed hands, text, watermark")
    node(16, "WanVaceToVideo", positive=positive, negative=negative, vae=vae,
         width=512, height=288, length=49, batch_size=1, strength=1,
         control_video=control, control_masks=mask)
    if reference:
        graph["16"]["inputs"]["reference_image"] = node(23, "LoadImage", image=reference)
    samples = node(17, "KSampler", model=model, positive=["16", 0], negative=["16", 1],
                   latent_image=["16", 2], seed=seed, steps=20, cfg=6,
                   sampler_name="uni_pc", scheduler="simple", denoise=1)
    trimmed = node(18, "TrimVideoLatent", samples=samples, trim_amount=["16", 3])
    decoded = node(19, "VAEDecode", samples=trimmed, vae=vae)
    # Only replace pixels inside the tracked shirt. Outside pixels are source frames.
    merged = node(20, "ImageCompositeMasked", destination=frames, source=decoded,
                  x=0, y=0, resize_source=False, mask=mask)
    output = node(21, "CreateVideo", images=merged, fps=16, audio=["2", 1])
    node(22, "SaveVideo", video=output, filename_prefix=f"{prefix}/replacement", format="mp4",
         **{"format.codec": "h264", "format.codec.encoding": "auto"})
    return graph


def artwork_workflow(filename, prefix, instruction, seed=421, reference=None, length=49, target=None):
    """Instruction-conditioned artwork editing; never substitutes canned artwork."""
    if not instruction or not instruction.strip():
        raise ValueError("Describe how the garment artwork should move.")
    subject = (
        f"Use the supplied reference image as the flat printed artwork on the selected {target}."
        if reference else
        f"Animate the existing printed artwork visible on the selected {target} in the source reference frame."
    )
    prompt = (
        f"{instruction.strip()}\n"
        f"{subject} The artwork performs this action continuously over time, independently "
        "of the wearer's body motion. It remains flat printed ink attached to the fabric, "
        "bending with folds and inheriting cloth texture, shadows and foreground occlusion. "
        "Preserve the garment's cut, color, seams and fit, the actor, camera and background. "
        "Do not create floating stickers or physical characters outside the print."
    )
    graph = workflow(filename, prefix, prompt, seed, reference, target)
    graph["16"]["inputs"]["length"] = length
    if not reference:
        # VACE receives the actual source appearance, not a monkey asset or invented design.
        graph["27"] = {"class_type": "ImageFromBatch", "inputs": {
            "image": ["2", 0], "batch_index": 0, "length": 1,
        }}
        graph["16"]["inputs"]["reference_image"] = ["27", 0]
    graph["15"]["inputs"]["text"] += ", static frozen print, motionless artwork, floating sticker, changed garment"
    return graph


def request(base, route, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + route, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, choices=[8188, 8189], default=8188)
    parser.add_argument("--input", required=True, help="Prepared 512x288, 16fps, 49-frame MP4 already in worker input")
    parser.add_argument("--report", required=True)
    parser.add_argument("--reference", help="Optional target garment image already in worker input")
    parser.add_argument("--target", required=True, help="Garment to segment, including identifying details")
    parser.add_argument("--prompt", default="The man wears an orange cotton button-down shirt with a full front row of buttons, natural fabric folds and realistic lighting. Preserve his original movement.")
    args = parser.parse_args()
    base = f"http://127.0.0.1:{args.port}"
    info = request(base, "/object_info")
    run_id = f"garment-proof-{uuid.uuid4().hex}"
    graph = workflow(args.input, run_id, args.prompt, reference=args.reference, target=args.target)
    missing = sorted({n["class_type"] for n in graph.values()} - set(info))
    if missing:
        raise RuntimeError(f"Required nodes missing: {missing}")
    for loader, field, filename in [
        ("UNETLoader", "unet_name", "wan2.1_vace_14B_fp16.safetensors"),
        ("CLIPLoader", "clip_name", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"),
        ("VAELoader", "vae_name", "wan_2.1_vae.safetensors"),
        ("CheckpointLoaderSimple", "ckpt_name", "sam3.1_multiplex_fp16.safetensors"),
    ]:
        definition = info[loader]["input"]["required"][field]
        choices = definition[0] if isinstance(definition[0], list) else definition[1].get("options", [])
        if filename not in choices:
            raise RuntimeError(f"Worker does not expose {filename}")
    queue = request(base, "/queue")
    if queue.get("queue_running") or queue.get("queue_pending"):
        raise RuntimeError("Worker is occupied; no test submitted. Retry after it is idle.")
    receipt = request(base, "/prompt", {"prompt": graph, "client_id": run_id})
    report = pathlib.Path(args.report)
    report.write_text(json.dumps({"receipt": receipt, "workflow": graph}, indent=2))
    prompt_id = receipt.get("prompt_id")
    if not prompt_id or receipt.get("node_errors"):
        raise RuntimeError(f"Workflow rejected: {receipt}")
    print(f"Submitted one local test: {prompt_id}. Receipt: {report}", flush=True)
    # Never resubmit an uncertain request. The receipt permits manual history recovery.
    for _ in range(720):
        history = request(base, f"/history/{prompt_id}")
        if prompt_id in history:
            report.write_text(json.dumps({"receipt": receipt, "workflow": graph, "history": history}, indent=2))
            status = history[prompt_id].get("status", {})
            print(json.dumps({"status": status, "outputs": history[prompt_id].get("outputs")}), flush=True)
            if status.get("status_str") != "success":
                raise RuntimeError("Worker test failed; inspect saved history. Not approved for production.")
            return
        time.sleep(5)
    raise RuntimeError("Monitor timed out; worker left untouched. Recover through the saved prompt ID.")


if __name__ == "__main__":
    main()
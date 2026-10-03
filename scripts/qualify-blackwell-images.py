"""Short, sequential image qualification against a private local ComfyUI worker."""
import json
import pathlib
import time
import urllib.request

BASE = "http://127.0.0.1:8189"
RESULTS = pathlib.Path("/tmp/obtv-image-qualification")
RESULTS.mkdir(exist_ok=True)


def request(route, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + route, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


for family in ["z-image", "qwen-image"]:
    queue = request("/queue")
    if queue["queue_running"] or queue["queue_pending"]:
        raise RuntimeError("Worker busy; refusing to add qualification work.")
    z = family == "z-image"
    graph = {}

    def node(key, kind, **inputs):
        graph[str(key)] = {"class_type": kind, "inputs": inputs}
        return [str(key), 0]

    model = node(1, "UNETLoader", unet_name="z_image_turbo_bf16.safetensors" if z else "qwen_image_2512_fp8_e4m3fn.safetensors", weight_dtype="default")
    clip = node(2, "CLIPLoader", clip_name="qwen_3_4b.safetensors" if z else "qwen_2.5_vl_7b_fp8_scaled.safetensors", type="lumina2" if z else "qwen_image", device="default")
    vae = node(3, "VAELoader", vae_name="ae.safetensors" if z else "qwen_image_vae.safetensors")
    sampled = node(4, "ModelSamplingAuraFlow", model=model, shift=3 if z else 3.1)
    pos = node(5, "CLIPTextEncode", clip=clip, text="A red ceramic teapot on a pale wooden table, studio product photograph, realistic lighting")
    neg = node(6, "ConditioningZeroOut", conditioning=pos) if z else node(6, "CLIPTextEncode", clip=clip, text="")
    latent = node(7, "EmptySD3LatentImage", width=768, height=768, batch_size=1)
    samples = node(8, "KSampler", model=sampled, positive=pos, negative=neg, latent_image=latent, seed=421,
                   steps=8 if z else 50, cfg=1 if z else 4, sampler_name="res_multistep" if z else "euler", scheduler="simple", denoise=1)
    decoded = node(9, "VAEDecode", samples=samples, vae=vae)
    node(10, "SaveImage", images=decoded, filename_prefix=f"qualification/{family}")
    receipt = request("/prompt", {"prompt": graph, "client_id": "obtv-qualification"})
    (RESULTS / f"{family}-receipt.json").write_text(json.dumps(receipt))
    print(f"{family} submitted: {receipt['prompt_id']}", flush=True)
    for attempt in range(120):
        result = request(f"/history/{receipt['prompt_id']}").get(receipt["prompt_id"])
        if result:
            (RESULTS / f"{family}-result.json").write_text(json.dumps(result))
            if result["status"]["status_str"] != "success":
                raise RuntimeError(f"{family} failed; inspect saved result")
            print(f"{family} execution succeeded: {result['outputs']}", flush=True)
            break
        time.sleep(10)
    else:
        raise RuntimeError(f"{family} timed out; inspect saved receipt before retrying")

print("IMAGE_EXECUTION_CHECKS_FINISHED; visual inspection still required", flush=True)
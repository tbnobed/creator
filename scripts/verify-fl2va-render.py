"""Bounded native FL2VA render/continuation probe. Graph supplied by app builder.

Outputs stay in /tmp; never interrupts or clears another job. Uses an idle worker
only. This checks native rendering, not the guided-production reference pipeline.
"""
import json
import pathlib
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
from PIL import Image, ImageDraw

base = sys.argv[1]
graph = json.loads(pathlib.Path(sys.argv[2]).read_text())
root = pathlib.Path("/tmp/fl2va-verification-" + uuid.uuid4().hex[:8])
root.mkdir()


def api(route, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base + route, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"HTTP {error.code}: {error.read().decode()}") from error


def upload(path):
    boundary = uuid.uuid4().hex
    name = root.name + "-" + path.name
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\n'
        'Content-Type: image/png\r\n\r\n'
    ).encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(base + "/upload/image", data=body,
                                 headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(req, timeout=60) as response:
        result = json.load(response)
    return "/".join(filter(None, [result.get("subfolder"), result["name"]]))


def run_frame(source, index):
    queue = api("/queue")
    if queue["queue_running"] or queue["queue_pending"]:
        raise RuntimeError("Worker is occupied; no test submitted.")
    prompt = json.loads(json.dumps(graph))
    prompt["137"]["inputs"]["image"] = upload(source)
    prompt["129"]["inputs"]["noise_seed"] += index
    prompt["92"]["inputs"]["filename_prefix"] = root.name + f"/shot-{index}"
    response = api("/prompt", {"prompt": prompt, "client_id": root.name})
    if response.get("node_errors"):
        raise RuntimeError(json.dumps(response))
    prompt_id = response["prompt_id"]
    print(json.dumps({"stage": "submitted", "shot": index, "promptId": prompt_id}), flush=True)
    (root / f"shot-{index}-receipt.json").write_text(json.dumps(response))
    start = time.monotonic()
    while time.monotonic() - start < 1800:
        history = api("/history/" + prompt_id).get(prompt_id)
        if history:
            (root / f"shot-{index}-history.json").write_text(json.dumps(history, indent=2))
            if history.get("status", {}).get("status_str") == "error":
                raise RuntimeError(json.dumps(history["status"]))
            files = []
            for output in history.get("outputs", {}).values():
                for values in output.values():
                    if isinstance(values, list):
                        files.extend(v for v in values if isinstance(v, dict) and str(v.get("filename", "")).endswith(".mp4"))
            if files:
                file = files[0]
                url = base + "/view?" + urllib.parse.urlencode({k: file[k] for k in ["filename", "subfolder", "type"] if k in file})
                target = root / f"shot-{index}.mp4"
                with urllib.request.urlopen(url, timeout=180) as response:
                    target.write_bytes(response.read())
                subprocess.run(["ffmpeg", "-v", "error", "-i", str(target), "-f", "null", "-"], check=True)
                metadata = subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(target)])
                (root / f"shot-{index}-probe.json").write_bytes(metadata)
                print(json.dumps({"stage": "completed", "shot": index, "seconds": round(time.monotonic()-start), "file": str(target)}), flush=True)
                return target
        time.sleep(10)
    raise RuntimeError(f"Timed out observing {prompt_id}; job NOT cancelled. Reconcile receipt before retrying.")


print("ARTIFACTS " + str(root), flush=True)
image = Image.new("RGB", (1280, 704), (158, 195, 215))
draw = ImageDraw.Draw(image)
draw.rectangle((0, 430, 1280, 704), fill=(190, 215, 230))
draw.ellipse((310, 485, 505, 515), fill=(120, 147, 166))
draw.ellipse((320, 335, 480, 495), fill=(196, 35, 40))
draw.ellipse((352, 358, 382, 388), fill=(245, 130, 130))
source = root / "first.png"
image.save(source)
first = run_frame(source, 1)
last = root / "continuation.png"
subprocess.run(["ffmpeg", "-v", "error", "-sseof", "-0.1", "-i", str(first), "-frames:v", "1", str(last)], check=True)
second = run_frame(last, 2)
for index, file in [(1, first), (2, second)]:
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(file), "-vf", "fps=1,scale=480:-1,tile=3x2", "-frames:v", "1", str(root / f"shot-{index}-contact.png")], check=True)
print("PASS two native renders decoded; visual inspection still required. " + str(root), flush=True)

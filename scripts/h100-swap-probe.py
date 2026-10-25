"""Run on the isolated host. Does not clear queues or unload models manually."""
import json, pathlib, subprocess, time, urllib.request, urllib.error, urllib.parse, sys, argparse

parser = argparse.ArgumentParser()
parser.add_argument("--full-resolution", action="store_true")
parser.add_argument("--port", type=int, default=8190)
parser.add_argument("--results-dir")
options = parser.parse_args()
full_resolution = options.full_resolution
root = pathlib.Path(options.results_dir or ("/var/tmp/h100-native-full-swap" if full_resolution else "/tmp/h100-swap-probe"))
root.mkdir(mode=0o700, exist_ok=True)
if list(root.glob("*-receipt.json")):
    raise RuntimeError("Results directory contains previous submissions; use a fresh directory.")
graphs = json.loads(pathlib.Path("/tmp/h100-swap-graphs.json").read_text())
base = f"http://127.0.0.1:{options.port}"

def api(route, payload=None):
    request = urllib.request.Request(base + route,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error

def health():
    result = subprocess.run(["nvidia-smi", "--query-gpu=index,uuid,temperature.gpu,temperature.memory,power.draw,power.limit,ecc.errors.uncorrected.volatile.total",
                             "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=12)
    with (root / "telemetry.log").open("a") as out:
        out.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + "\n" + result.stdout + result.stderr)
    rows = [r for r in result.stdout.splitlines() if "GPU-" in r]
    if result.returncode or len(rows) != 2 or "Unknown Error" in result.stdout:
        raise RuntimeError("GPU telemetry failed; test stopped. No additional jobs submitted.")
    for row in rows:
        fields = [x.strip() for x in row.split(",")]
        if int(fields[-1]) != 0:
            raise RuntimeError("Uncorrectable ECC detected; test stopped.")

def verify_outputs(item, name, index):
    from PIL import Image
    import av
    files = [
        entry for output in item.get("outputs", {}).values()
        for entries in output.values() if isinstance(entries, list)
        for entry in entries if isinstance(entry, dict)
        and str(entry.get("filename", "")).endswith((".mp4", ".png"))
    ]
    if not files:
        raise RuntimeError("No output media found.")
    for number, entry in enumerate(files):
        query = urllib.parse.urlencode({k: entry[k] for k in ["filename", "subfolder", "type"] if k in entry})
        path = root / f"{index}-{name}-{number}{pathlib.Path(entry['filename']).suffix}"
        with urllib.request.urlopen(base + "/view?" + query, timeout=120) as response:
            path.write_bytes(response.read())
        if path.suffix == ".png":
            with Image.open(path) as image:
                image.load()
                assert image.size == (1024, 1024), image.size
        else:
            with av.open(str(path)) as container:
                frames = 0
                for frame in container.decode(video=0):
                    assert (frame.width, frame.height) == (1280, 736)
                    frames += 1
                assert frames == 124, frames
    print(f"VERIFIED {index+1}/6 {name} decoded at expected resolution", flush=True)

if full_resolution:
    stats = api("/system_stats")
    args = stats["system"]["argv"]
    assert "--disable-cuda-malloc" in args and "--disable-dynamic-vram" in args
    assert all("cudaMallocAsync" not in device["name"] for device in stats["devices"])
    assert (graphs["h3"]["136"]["inputs"]["width"], graphs["h3"]["136"]["inputs"]["height"]) == (1280, 736)
    assert (graphs["flux"]["6"]["inputs"]["width"], graphs["flux"]["6"]["inputs"]["height"]) == (1024, 1024)
    (root / "system-stats.json").write_text(json.dumps(stats))
    (root / "graphs.json").write_text(json.dumps(graphs))
    print("VERIFIED: native allocator; H3 1280x736, FLUX 1024x1024", flush=True)

for index, name in enumerate(["h3", "flux"] * 3):
    health()
    q = api("/queue")
    if q["queue_running"] or q["queue_pending"]:
        raise RuntimeError("Worker occupied; refusing to submit.")
    graph = json.loads(json.dumps(graphs[name]))
    graph["129" if name == "h3" else "10"]["inputs"]["noise_seed"] = 541 + index
    # Force text encoding too, rather than accidentally testing cached outputs.
    graph["138" if name == "h3" else "4"]["inputs"]["value" if name == "h3" else "text"] += f" Take {index + 1}."
    receipt = api("/prompt", {"prompt": graph, "client_id": "isolated-swap-probe"})
    if receipt.get("node_errors"):
        raise RuntimeError(json.dumps(receipt))
    pid = receipt["prompt_id"]
    (root / f"{index}-{name}-receipt.json").write_text(json.dumps(receipt))
    print(f"SUBMITTED {index+1}/6 {name} {pid}", flush=True)
    started = time.monotonic()
    while time.monotonic() - started < 1800:
        health()
        item = api("/history/" + pid).get(pid)
        if item:
            (root / f"{index}-{name}-history.json").write_text(json.dumps(item))
            if item.get("status", {}).get("status_str") == "error":
                raise RuntimeError(json.dumps(item["status"]))
            if item.get("status", {}).get("completed"):
                if full_resolution:
                    verify_outputs(item, name, index)
                print(f"COMPLETED {index+1}/6 {name} {time.monotonic()-started:.1f}s", flush=True)
                break
        time.sleep(2 if full_resolution else 10)
    else:
        raise RuntimeError("Observation timed out; reconcile saved receipt before further submission.")
health()
print("PASS: six jobs, five model-family transitions. Not a long-term stability certification.", flush=True)

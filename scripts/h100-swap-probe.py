"""Run on the isolated host. Does not clear queues or unload models manually."""
import json, pathlib, subprocess, time, urllib.request, urllib.error

root = pathlib.Path("/tmp/h100-swap-probe")
root.mkdir(exist_ok=True)
graphs = json.loads(pathlib.Path("/tmp/h100-swap-graphs.json").read_text())
base = "http://127.0.0.1:8190"

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
                print(f"COMPLETED {index+1}/6 {name} {time.monotonic()-started:.1f}s", flush=True)
                break
        time.sleep(10)
    else:
        raise RuntimeError("Observation timed out; reconcile saved receipt before further submission.")
health()
print("PASS: six jobs, five model-family transitions. Not a long-term stability certification.", flush=True)

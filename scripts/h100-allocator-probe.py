"""Isolated 1024px FLUX repetition test; never clears queues or reboots."""
import json
import pathlib
import subprocess
import threading
import time
import urllib.request
import urllib.error

root = pathlib.Path("/var/tmp/h100-allocator-probe")
root.mkdir(mode=0o700, exist_ok=True)
base = "http://127.0.0.1:8190"
graph_source = json.loads((root / "graph.json").read_text())
stop = threading.Event()
failures = []


def api(route, payload=None):
    request = urllib.request.Request(
        base + route,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error


def telemetry():
    while not stop.is_set():
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=index,uuid,temperature.gpu,temperature.memory,power.draw,power.limit,ecc.errors.uncorrected.volatile.total",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=12,
            )
            with (root / "telemetry.log").open("a") as out:
                out.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + "\n" + result.stdout + result.stderr)
            rows = [line.split(",") for line in result.stdout.splitlines() if "GPU-" in line]
            if result.returncode or len(rows) != 2 or "Unknown Error" in result.stdout:
                raise RuntimeError("GPU telemetry lost; stop submitting.")
            if any(int(row[-1].strip()) != 0 for row in rows):
                raise RuntimeError("Uncorrectable ECC detected.")
        except Exception as error:
            failures.append(str(error))
            stop.set()
            return
        stop.wait(1)


def healthy():
    if failures:
        raise RuntimeError(failures[0])


stats = api("/system_stats")
argv = stats["system"]["argv"]
assert "--disable-dynamic-vram" in argv
assert "--disable-cuda-malloc" in argv
assert all("cudaMallocAsync" not in item["name"] for item in stats["devices"])
(root / "system-stats.json").write_text(json.dumps(stats))
print("VERIFIED: dynamic VRAM disabled; cudaMallocAsync disabled", flush=True)
thread = threading.Thread(target=telemetry, daemon=True)
thread.start()
try:
    for index in range(50):
        healthy()
        queue = api("/queue")
        if queue["queue_running"] or queue["queue_pending"]:
            raise RuntimeError("Worker occupied; refusing test submission.")
        graph = json.loads(json.dumps(graph_source))
        seeds = 0
        for node in graph.values():
            if node["class_type"] == "RandomNoise":
                node["inputs"]["noise_seed"] = 98100 + index
                seeds += 1
            if node["class_type"] == "SaveImage":
                node["inputs"]["filename_prefix"] = "diagnostics/allocator-probe/flux1024"
        assert seeds > 0, "Cannot force fresh sampling without a seed node."
        receipt = api("/prompt", {"prompt": graph, "client_id": "isolated-allocator-probe"})
        if receipt.get("node_errors"):
            raise RuntimeError(json.dumps(receipt))
        pid = receipt["prompt_id"]
        (root / f"{index:02d}-receipt.json").write_text(json.dumps(receipt))
        print(f"SUBMITTED {index+1}/50 {pid}", flush=True)
        started = time.monotonic()
        while time.monotonic() - started < 600:
            healthy()
            item = api("/history/" + pid).get(pid)
            if item:
                (root / f"{index:02d}-history.json").write_text(json.dumps(item))
                if item.get("status", {}).get("status_str") == "error":
                    raise RuntimeError(json.dumps(item["status"]))
                if item.get("status", {}).get("completed"):
                    print(f"COMPLETED {index+1}/50 {time.monotonic()-started:.1f}s", flush=True)
                    break
            time.sleep(1)
        else:
            raise RuntimeError("Job observation timed out; inspect receipt before retry.")
        # Include idle/re-entry intervals, not only a continuously hot loop.
        if (index + 1) % 5 == 0 and index < 49:
            print("IDLE 60 seconds before next batch", flush=True)
            stop.wait(60)
            healthy()
    healthy()
    print("PASS: 50 completed 1024x1024 FLUX jobs. Not a root-cause or long-term stability certification.", flush=True)
finally:
    stop.set()
    thread.join(timeout=15)

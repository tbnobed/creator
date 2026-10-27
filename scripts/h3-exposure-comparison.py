"""One-shot local-GPU comparison. Never retries submissions or clears queues."""
import argparse
import json
import pathlib
import time
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--worker", required=True)
parser.add_argument("--graph", required=True)
parser.add_argument("--results", required=True)
args = parser.parse_args()
root = pathlib.Path(args.results)
root.mkdir(mode=0o700, parents=True, exist_ok=False)


def api(route, payload=None):
    request = urllib.request.Request(
        args.worker + route,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


queue = api("/queue")
if queue["queue_running"] or queue["queue_pending"]:
    raise RuntimeError("Worker occupied; no diagnostic job submitted.")
graph = json.loads(pathlib.Path(args.graph).read_text())
(root / "submitted-graph.json").write_text(json.dumps(graph))
receipt = api("/prompt", {"prompt": graph, "client_id": "positive-exposure-comparison"})
(root / "receipt.json").write_text(json.dumps(receipt))
if receipt.get("node_errors"):
    raise RuntimeError(json.dumps(receipt["node_errors"]))
pid = receipt["prompt_id"]
print(f"SUBMITTED {pid}. No automatic retries.", flush=True)
start = time.monotonic()
while time.monotonic() - start < 1200:
    entry = api("/history/" + pid).get(pid)
    if entry:
        (root / "history.json").write_text(json.dumps(entry))
        if entry.get("status", {}).get("status_str") == "error":
            raise RuntimeError(json.dumps(entry["status"]))
        if entry.get("status", {}).get("completed"):
            outputs = [
                item for node in entry.get("outputs", {}).values()
                for item in node.get("images", [])
                if item["filename"].endswith(".mp4")
            ]
            if len(outputs) != 1:
                raise RuntimeError("Expected one MP4 output.")
            query = urllib.parse.urlencode(outputs[0])
            with urllib.request.urlopen(args.worker + "/view?" + query, timeout=90) as response:
                (root / "output.mp4").write_bytes(response.read())
            print(f"COMPLETED in {time.monotonic()-start:.1f}s. Output saved for measurement.", flush=True)
            break
    time.sleep(5)
else:
    raise RuntimeError("Observation timed out. Receipt retained; do not resubmit blindly.")

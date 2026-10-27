#!/usr/bin/python3
import os, re, subprocess, sys
# Explicit CreatorAI allowlist. GPU 1 / 3g.40gb is reserved and never selected.
assignments = {
 "0": ("GPU-4f5b19ff-6860-134c-51fa-78c273778ddf", "4g.40gb", 8188),
 "1": ("GPU-0e1c4502-e952-091a-ea96-f815459d59f4", "4g.40gb", 8189),
 "2": ("GPU-4f5b19ff-6860-134c-51fa-78c273778ddf", "3g.40gb", 8190),
}
if len(sys.argv) != 2 or sys.argv[1] not in assignments:
 raise SystemExit("Not an assigned CreatorAI worker")
worker = sys.argv[1]
parent, profile, port = assignments[worker]
current = None
matches = []
for line in subprocess.check_output(["/usr/bin/nvidia-smi", "-L"], text=True, timeout=15).splitlines():
 match = re.match(r"GPU \d+:.*\(UUID: (GPU-[^)]+)\)", line)
 if match: current = match.group(1)
 match = re.search(r"MIG (\S+)\s+Device\s+\d+: \(UUID: (MIG-[^)]+)\)", line)
 if match and current == parent and match.group(1) == profile:
  matches.append(match.group(2))
if len(matches) != 1:
 raise SystemExit("Expected exactly one assigned MIG profile, refusing whole-GPU fallback")
os.environ["CUDA_VISIBLE_DEVICES"] = matches[0]
base = "/var/lib/obtv/comfy" + worker
args = ["/opt/obtv/venv/bin/python", "/opt/obtv/ComfyUI/main.py", "--listen", "0.0.0.0", "--port", str(port),
 "--input-directory", base+"/input", "--output-directory", base+"/output", "--temp-directory", base+"/temp",
 "--user-directory", base+"/user", "--disable-auto-launch", "--disable-dynamic-vram", "--disable-cuda-malloc"]
print("CreatorAI worker", worker, "assigned", parent, profile, matches[0], flush=True)
os.execv(args[0], args)

#!/usr/bin/env bash
# Run as root on the dual-H100 host after an explicitly approved recovery.
set -euo pipefail
RUN="/var/backups/obtv-h100-recovery/matched-slices-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$RUN"
exec > >(tee "$RUN/comparison.log") 2>&1
echo "EVIDENCE $RUN"
test -f /etc/obtv/h100-recovery-hold
for unit in 0 1 2; do
  if systemctl is-active --quiet "obtv-comfy@$unit"; then
    echo "Worker already active; refusing test"; exit 1
  fi
done
cp /var/tmp/h100-native-full-swap/graphs.json /tmp/h100-swap-graphs.json
START=$(date -u --iso-8601=seconds)
cleanup() {
  status=$?
  trap - EXIT
  systemctl stop obtv-comfy@0 obtv-comfy@1 || true
  journalctl -k --since "$START" --no-pager > "$RUN/kernel.log"
  journalctl -u obtv-comfy@0 -u obtv-comfy@1 --since "$START" --no-pager > "$RUN/workers.log"
  if [ "$status" != 0 ]; then
    (cd "$RUN"; timeout 180 nvidia-bug-report.sh --safe-mode) || true
  fi
  for unit in 0 1; do
    rm -f "/etc/systemd/system/obtv-comfy@$unit.service.d/zzz-matched-slice-test.conf"
  done
  systemctl daemon-reload
  iptables -D INPUT ! -i lo -p tcp --dport 8188:8190 -m comment --comment obtv-matched-slice-test -j REJECT || true
  chmod -R go-rwx "$RUN"
  echo "Comparison exit=$status. Production hold retained. Evidence: $RUN"
  exit "$status"
}
iptables -I INPUT 1 ! -i lo -p tcp --dport 8188:8190 -m comment --comment obtv-matched-slice-test -j REJECT
trap cleanup EXIT
for unit in 1 0; do
  /usr/local/sbin/obtv-h100-guard --check
  if [ "$unit" = 1 ]; then
    MIG=MIG-afbf9abb-9c62-570c-a646-6a4022e64a3a
  else
    MIG=MIG-b215bab1-2252-5f4c-acb8-496dcd3a3556
  fi
  port=$((8188 + unit))
  nvidia-smi -L | grep -F "$MIG"
  dir="/etc/systemd/system/obtv-comfy@$unit.service.d"
  mkdir -p "$dir"
  cat > "$dir/zzz-matched-slice-test.conf" <<EOF
[Unit]
ConditionPathExists=
[Service]
Environment=CUDA_VISIBLE_DEVICES=$MIG
ExecStart=
ExecStart=/usr/bin/env CUDA_VISIBLE_DEVICES=$MIG /opt/obtv/venv/bin/python /opt/obtv/ComfyUI/main.py --listen 0.0.0.0 --port $port --input-directory /var/lib/obtv/comfy$unit/input --output-directory /var/lib/obtv/comfy$unit/output --temp-directory /var/lib/obtv/comfy$unit/temp --user-directory /var/lib/obtv/comfy$unit/user --disable-auto-launch --disable-dynamic-vram --disable-cuda-malloc
Restart=no
EOF
  systemctl daemon-reload
  systemctl show "obtv-comfy@$unit" -p ExecStart -p Environment > "$RUN/gpu$unit-service.txt"
  grep -q -- --disable-cuda-malloc "$RUN/gpu$unit-service.txt"
  echo "STARTING GPU $unit matching 4g.40gb slice"
  systemctl start "obtv-comfy@$unit"
  ready=0
  for attempt in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:$port/system_stats" > "$RUN/gpu$unit-startup.json" 2>/dev/null; then ready=1; break; fi
    if systemctl is-failed --quiet "obtv-comfy@$unit"; then break; fi
    sleep 2
  done
  test "$ready" = 1
  /opt/obtv/venv/bin/python -c 'import json,sys; s=json.load(open(sys.argv[1])); assert all("4g.40gb" in d["name"] and "native" in d["name"] for d in s["devices"]), s["devices"]' "$RUN/gpu$unit-startup.json"
  /opt/obtv/venv/bin/python -u /tmp/h100-swap-probe.py --full-resolution --port "$port" --results-dir "$RUN/gpu$unit"
  systemctl stop "obtv-comfy@$unit"
  rm "$dir/zzz-matched-slice-test.conf"
  systemctl daemon-reload
  echo "GPU $unit SIX JOBS PASSED"
done
echo "BOTH MATCHING SLICES PASSED. This is not a long-term stability certification."

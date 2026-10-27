#!/usr/bin/env bash
# Operator-approved GPU 0 link-speed experiment. Do not restart GPU 1.
set -euo pipefail
MODE=${1:---live-gen4}
case "$MODE" in --live-gen4|--firmware-gen4) ;; *) echo "Use --live-gen4 or --firmware-gen4"; exit 2 ;; esac
ROOT=0000:c0:01.1
GPU=0000:c1:00.0
RUN="/var/backups/obtv-h100-recovery/gen4-comparison-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$RUN"
exec > >(tee "$RUN/test.log") 2>&1
echo "EVIDENCE $RUN"
test -f /etc/obtv/h100-gpu0-quarantine
test -s /var/tmp/h100-allocator-probe/graph.json
if [ "$MODE" = --live-gen4 ] && grep -Eq '\[(integrity|confidentiality)\]' /sys/kernel/security/lockdown 2>/dev/null; then
  echo "BLOCKED: kernel lockdown prohibits direct PCI writes. Use the approved BIOS slot-speed setting; do not disable security controls."
  exit 2
fi
/usr/local/sbin/obtv-h100-guard --check
for unit in 0 2; do
  if systemctl is-active --quiet "obtv-comfy@$unit"; then echo "GPU 0 worker active; abort"; exit 1; fi
done
if nvidia-smi --query-compute-apps=gpu_uuid --format=csv,noheader | grep -qF GPU-4f5b19ff-6860-134c-51fa-78c273778ddf; then
  echo "GPU 0 has compute clients; abort"; exit 1
fi
readlink -f "/sys/bus/pci/devices/$GPU" | grep -F "/$ROOT/$GPU"
nvidia-smi -L | tee "$RUN/mig-before.txt" | grep -F MIG-e0c9f37c-870d-504b-8345-80326d502d98
ORIGINAL=$(setpci -s "$ROOT" CAP_EXP+30.w)
if [ "$MODE" = --firmware-gen4 ]; then test "$ORIGINAL" = 0004; else test "$ORIGINAL" = 0005; fi
printf '%s\n' "$ORIGINAL" > "$RUN/original-target-register.txt"
setpci -s "$ROOT" CAP_EXP+10.w > "$RUN/original-link-control.txt"
START=$(date -u --iso-8601=seconds)
changed=0
pci_write() {
  local result
  result=$(setpci -s "$ROOT" "$1" 2>&1) || { printf '%s\n' "$result"; return 1; }
  # Some pciutils builds return zero even when sysfs rejected the write.
  if [ -n "$result" ]; then printf '%s\n' "$result"; return 1; fi
}
cleanup() {
  status=$?
  trap - EXIT
  systemctl stop obtv-comfy@2 || true
  rm -f /etc/systemd/system/obtv-comfy@2.service.d/zzz-gen4-test.conf
  systemctl daemon-reload
  journalctl -k --since "$START" --no-pager > "$RUN/kernel.log"
  journalctl -u obtv-comfy@2 --since "$START" --no-pager > "$RUN/worker.log"
  if [ "$status" = 0 ] && [ "$changed" = 1 ]; then
    if ! pci_write CAP_EXP+30.w=0005:000f || ! pci_write CAP_EXP+10.w=0020:0020; then
      echo "Original speed restoration write failed"; status=1
    fi
    sleep 2
    lspci -s "$GPU" -vv > "$RUN/gpu-after-restoration.txt"
    if ! grep -q 'LnkSta:.*Speed 32GT/s, Width x16' "$RUN/gpu-after-restoration.txt"; then
      echo "Original speed not confirmed after restoration"; status=1
    fi
  fi
  if [ "$status" != 0 ]; then
    (cd "$RUN"; timeout 180 nvidia-bug-report.sh --safe-mode) || true
    echo "Failure: no further retraining, worker restart, or reboot attempted."
  fi
  journalctl -k --since "$START" --no-pager > "$RUN/kernel.log"
  iptables -D INPUT ! -i lo -p tcp --dport 8190 -m comment --comment obtv-gen4-test -j REJECT || true
  chmod -R go-rwx "$RUN"
  echo "GEN4 COMPARISON EXIT=$status; GPU 0 remains quarantined. Evidence: $RUN"
  exit "$status"
}
iptables -I INPUT 1 ! -i lo -p tcp --dport 8190 -m comment --comment obtv-gen4-test -j REJECT
trap cleanup EXIT
if [ "$MODE" = --live-gen4 ]; then
  pci_write CAP_EXP+30.w=0004:000f
  test "$(setpci -s "$ROOT" CAP_EXP+30.w)" = 0004
  changed=1
  pci_write CAP_EXP+10.w=0020:0020
fi
sleep 2
for device in "$ROOT" "$GPU"; do
  lspci -s "$device" -vv > "$RUN/${device//:/-}-gen4.txt"
  grep 'LnkSta:' "$RUN/${device//:/-}-gen4.txt"
  grep -q 'LnkSta:.*Speed 16GT/s, Width x16' "$RUN/${device//:/-}-gen4.txt"
done
test "$(setpci -s "$ROOT" CAP_EXP+30.w)" = 0004
test "$(setpci -s 0000:f0:01.1 CAP_EXP+30.w)" = 0005
/usr/local/sbin/obtv-h100-guard --check
cat > /etc/systemd/system/obtv-comfy@2.service.d/zzz-gen4-test.conf <<'EOF'
[Unit]
ConditionPathExists=
[Service]
ExecStart=
ExecStart=/usr/bin/env CUDA_VISIBLE_DEVICES=MIG-e0c9f37c-870d-504b-8345-80326d502d98 /opt/obtv/venv/bin/python /opt/obtv/ComfyUI/main.py --listen 0.0.0.0 --port 8190 --input-directory /var/lib/obtv/comfy2/input --output-directory /var/lib/obtv/comfy2/output --temp-directory /var/lib/obtv/comfy2/temp --user-directory /var/lib/obtv/comfy2/user --disable-auto-launch --disable-dynamic-vram --disable-cuda-malloc
Restart=no
EOF
systemctl daemon-reload
systemctl reset-failed obtv-comfy@2
systemctl start obtv-comfy@2
ready=0
for attempt in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8190/system_stats > "$RUN/system-stats.json" 2>/dev/null; then ready=1; break; fi
  if systemctl is-failed --quiet obtv-comfy@2; then break; fi
  sleep 2
done
test "$ready" = 1
/opt/obtv/venv/bin/python -c 'import json,sys; s=json.load(open(sys.argv[1])); assert len(s["devices"])==1 and "3g.40gb" in s["devices"][0]["name"] and "native" in s["devices"][0]["name"]' "$RUN/system-stats.json"
echo "VERIFIED GPU 0 Gen4 x16, GPU 1 target unchanged at Gen5; running native-allocator image comparison"
/opt/obtv/venv/bin/python -u /tmp/h100-allocator-probe.py --results-dir "$RUN/results"
test "$(setpci -s "$ROOT" CAP_EXP+30.w)" = 0004
/usr/local/sbin/obtv-h100-guard --check
if journalctl -k --since "$START" --no-pager | grep -Eq 'Xid.*: (79|119|120|154),|unmasked uncorrectable|Uncorrectable \(Fatal\)'; then
  echo "Kernel GPU/PCIe error detected; comparison failed"; exit 1
fi
echo "GEN4 IMAGE SEQUENCE PASSED; stopping diagnostic worker. Live-mode changes are restored; firmware settings are left unchanged."

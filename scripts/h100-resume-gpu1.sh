#!/usr/bin/env bash
# Restore only the permitted GPU 1 slice after an operator-approved reboot.
set -euo pipefail
test -f /etc/obtv/h100-recovery-hold
test -f /etc/obtv/h100-gpu0-quarantine
/usr/local/sbin/obtv-h100-guard --check
for unit in 0 1 2; do
  if systemctl is-active --quiet "obtv-comfy@$unit"; then
    echo "Unexpected active worker; recovery remains held"; exit 1
  fi
done
nvidia-smi -L | grep -F 'MIG-afbf9abb-9c62-570c-a646-6a4022e64a3a'
for unit in 0 2; do
  grep -qF 'ConditionPathExists=!/etc/obtv/h100-gpu0-quarantine' \
    "/etc/systemd/system/obtv-comfy@$unit.service.d/99-gpu0-quarantine.conf"
done
cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" != 0 ]; then
    touch /etc/obtv/h100-recovery-hold
    systemctl stop obtv-comfy@1 || true
    echo "GPU 1 verification failed; global recovery hold restored"
  fi
  iptables -D INPUT ! -i lo -p tcp --dport 8189 -m comment --comment obtv-gpu1-recovery -j REJECT || true
  exit "$status"
}
iptables -I INPUT 1 ! -i lo -p tcp --dport 8189 -m comment --comment obtv-gpu1-recovery -j REJECT
trap cleanup EXIT
rm /etc/obtv/h100-recovery-hold
systemctl reset-failed obtv-comfy@1
systemctl enable obtv-comfy@1
systemctl start obtv-comfy@1
/opt/obtv/venv/bin/python - <<'PY'
import json, time, urllib.request
for attempt in range(90):
    try:
        with urllib.request.urlopen("http://127.0.0.1:8189/system_stats", timeout=5) as response:
            stats = json.load(response)
        break
    except OSError:
        time.sleep(2)
else:
    raise RuntimeError("GPU 1 endpoint failed to become ready")
assert len(stats["devices"]) == 1
assert "4g.40gb" in stats["devices"][0]["name"] and "native" in stats["devices"][0]["name"]
assert all(flag in stats["system"]["argv"] for flag in ["--disable-dynamic-vram", "--disable-cuda-malloc"])
print(json.dumps({"device":stats["devices"][0]["name"], "flags_verified": True}))
PY
/usr/local/sbin/obtv-h100-guard --check
for unit in 0 2; do
  if systemctl is-active --quiet "obtv-comfy@$unit"; then
    echo "Unexpected active quarantined worker"; exit 1
  fi
done
systemctl is-active obtv-comfy@1
systemctl is-enabled obtv-comfy@1
echo "GPU 1 ready. GPU 0 workers remain quarantined. Restoring port 8189 intake."

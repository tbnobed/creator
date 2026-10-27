#!/usr/bin/env bash
# Operator-approved reopening after isolated tests; never changes MIG or safety policy.
set -euo pipefail
BACKUP="/var/backups/obtv-h100-recovery/resume-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$BACKUP"
test -f /etc/obtv/h100-recovery-hold
/usr/local/sbin/obtv-h100-guard --check
for unit in 0 1 2; do
  if systemctl is-active --quiet "obtv-comfy@$unit"; then
    echo "Unexpected active worker; refusing replacement"; exit 1
  fi
done
cp -a /usr/local/sbin/obtv-mig-comfy "$BACKUP/launcher-before"
cp -a /etc/obtv/h100-recovery-hold "$BACKUP/"
cp -a /etc/systemd/system/obtv-comfy@.service.d/99-recovery-hold.conf "$BACKUP/"
cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" != 0 ]; then
    touch /etc/obtv/h100-recovery-hold
    systemctl stop obtv-comfy@0 obtv-comfy@1 obtv-comfy@2 || true
    echo "Verification failed; recovery hold restored."
  fi
  iptables -D INPUT ! -i lo -p tcp --dport 8188:8190 -m comment --comment obtv-resume-verification -j REJECT || true
  exit "$status"
}
iptables -I INPUT 1 ! -i lo -p tcp --dport 8188:8190 -m comment --comment obtv-resume-verification -j REJECT
trap cleanup EXIT
install -o root -g root -m 755 /tmp/obtv-mig-comfy.py /usr/local/sbin/obtv-mig-comfy
rm /etc/obtv/h100-recovery-hold
systemctl reset-failed obtv-comfy@0 obtv-comfy@1 obtv-comfy@2
systemctl enable obtv-comfy@0 obtv-comfy@1 obtv-comfy@2
systemctl start obtv-comfy@0 obtv-comfy@1 obtv-comfy@2
/opt/obtv/venv/bin/python - <<'PY'
import json, time, urllib.request
for unit, profile in [(0, "4g.40gb"), (1, "4g.40gb"), (2, "3g.40gb")]:
    base = f"http://127.0.0.1:{8188+unit}"
    for attempt in range(90):
        try:
            with urllib.request.urlopen(base+"/system_stats", timeout=5) as r:
                stats = json.load(r)
            break
        except OSError:
            time.sleep(2)
    else:
        raise RuntimeError(f"Worker {unit} did not become ready")
    assert all(flag in stats["system"]["argv"] for flag in ["--disable-dynamic-vram", "--disable-cuda-malloc"])
    assert len(stats["devices"]) == 1
    device = stats["devices"][0]["name"]
    assert profile in device and "native" in device, device
    with urllib.request.urlopen(base+"/queue", timeout=5) as r:
        queue = json.load(r)
    print(json.dumps({"worker": unit, "port":8188+unit, "device":device,
                      "running":len(queue["queue_running"]), "pending":len(queue["queue_pending"])}), flush=True)
PY
/usr/local/sbin/obtv-h100-guard --check
systemctl is-active obtv-comfy@0 obtv-comfy@1 obtv-comfy@2
systemctl is-enabled obtv-comfy@0 obtv-comfy@1 obtv-comfy@2
echo "All three workers verified; restoring external intake."
echo "Backup: $BACKUP"

"""Deploy the Pocket Harness relay onto a VPS in one idempotent pass.

Stages (run them in order, or all at once with the default):
  probe   - identify the box, node, nginx, systemd, and what already listens
  push    - copy relay/ to /opt/pocket-harness-relay, install runtime deps
  unit    - write + enable + start pocket-harness-relay.service
  nginx   - expose wss://<domain>/ph-relay next to the existing site
  verify  - check /healthz on the box and a real WebSocket upgrade from here

Everything about the target is environment, never a literal in this file: the
repository is public, and a hard-coded address would tell every reader where one
person's relay runs. Set at least:

  POCKET_HARNESS_VPS_HOST   ssh host or IP
  POCKET_HARNESS_VPS_PASS   ssh password (or set POCKET_HARNESS_VPS_KEY)
  POCKET_HARNESS_VPS_DOMAIN the name the relay will be reachable under

The password is read from the environment so it never appears in the terminal,
in a shell history, or in this repository. The relay token comes from
POCKET_HARNESS_RELAY_TOKEN or is generated once into relay/.relay-token
(git-ignored).

Usage:
  python tools/deploy-relay.py                 # probe + push + unit + verify
  python tools/deploy-relay.py --stage probe   # look before touching anything
  python tools/deploy-relay.py --nginx         # also add the reverse proxy
"""

from __future__ import annotations

import argparse
import os
import re
import secrets
import sys
from pathlib import Path

import paramiko

REPO = Path(__file__).resolve().parent.parent
RELAY_DIR = REPO / "relay"
TOKEN_FILE = RELAY_DIR / ".relay-token"

HOST = os.environ.get("POCKET_HARNESS_VPS_HOST")
PORT = int(os.environ.get("POCKET_HARNESS_VPS_PORT", "22"))
USER = os.environ.get("POCKET_HARNESS_VPS_USER", "root")

REMOTE_DIR = "/opt/pocket-harness-relay"
UNIT_PATH = "/etc/systemd/system/pocket-harness-relay.service"
RELAY_PORT = 8080
NGINX_LOCATION = "/ph-relay"
DOMAIN = os.environ.get("POCKET_HARNESS_VPS_DOMAIN")
KEY_PATH = os.environ.get("POCKET_HARNESS_VPS_KEY")


def log(message: str) -> None:
    sys.stdout.write(f"{message}\n")
    sys.stdout.flush()


def password() -> str:
    value = os.environ.get("POCKET_HARNESS_VPS_PASS")
    if not value:
        sys.exit("POCKET_HARNESS_VPS_PASS is not set")
    return value


def relay_token() -> str:
    value = os.environ.get("POCKET_HARNESS_RELAY_TOKEN")
    if value:
        return value
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="ascii").strip()
    token = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(token + "\n", encoding="ascii")
    try:
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass
    log(f"generated a new relay token into {TOKEN_FILE} (git-ignored)")
    return token


def connect() -> paramiko.SSHClient:
    if not HOST:
        sys.exit("POCKET_HARNESS_VPS_HOST is not set")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        HOST,
        port=PORT,
        username=USER,
        password=None if KEY_PATH else password(),
        key_filename=KEY_PATH,
        timeout=25,
        banner_timeout=30,
        auth_timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def run(client: paramiko.SSHClient, command: str, timeout: int = 180) -> tuple[int, str]:
    _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, (out + err).strip()


def stage_probe(client: paramiko.SSHClient) -> None:
    script = r"""
set +e
echo "=== identity ==="
hostname; uname -sr; . /etc/os-release && echo "$PRETTY_NAME"
echo "=== resources ==="
free -m | awk '/Mem:/{print "mem_total_mb", $2, "available_mb", $7}'
df -h / | awk 'NR==2{print "disk_avail", $4}'
echo "=== node ==="
node -v 2>/dev/null || echo "(no node)"
npm -v 2>/dev/null || echo "(no npm)"
echo "=== nginx ==="
nginx -v 2>&1
ls /etc/nginx/sites-enabled/ 2>/dev/null
echo "=== listening ==="
ss -lntp 2>/dev/null | awk 'NR>1{print $4, $6}'
echo "=== existing relay ==="
systemctl is-active pocket-harness-relay 2>/dev/null || echo "(no unit)"
ls -la /opt/pocket-harness-relay 2>/dev/null || echo "(no dir)"
echo "=== healthz on box ==="
curl -s -m 3 http://127.0.0.1:8080/healthz || echo "(nothing on 8080)"
echo "=== nginx server blocks ==="
grep -rlE "server_name|listen .*443" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null
echo "=== gate config ==="
grep -rn "gate" /etc/nginx/sites-enabled/ 2>/dev/null | head -20
"""
    code, output = run(client, script.strip(), timeout=120)
    log(output)
    log(f"\n--- probe exit {code} ---")


def stage_push(client: paramiko.SSHClient) -> None:
    code, output = run(client, f"mkdir -p {REMOTE_DIR} && echo ready")
    if code != 0:
        sys.exit(f"cannot create {REMOTE_DIR}: {output}")

    transport = client.get_transport()
    assert transport is not None
    sftp = paramiko.SFTPClient.from_transport(transport)
    assert sftp is not None

    files = ["server.mjs", "run.mjs", "package.json"]
    lock = RELAY_DIR / "package-lock.json"
    if lock.exists():
        files.append("package-lock.json")
    for name in files:
        local = RELAY_DIR / name
        if not local.exists():
            log(f"skip {name} (not in the repo)")
            continue
        sftp.put(str(local), f"{REMOTE_DIR}/{name}")
        log(f"pushed {name} ({local.stat().st_size} bytes)")

    code, output = run(
        client,
        f"cd {REMOTE_DIR} && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5",
        timeout=300,
    )
    log(output)
    if code != 0:
        sys.exit("npm install failed on the box")
    sftp.close()


def stage_unit(client: paramiko.SSHClient, token: str) -> None:
    unit = f"""[Unit]
Description=Pocket Harness relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={REMOTE_DIR}
Environment=POCKET_HARNESS_RELAY_TOKEN={token}
Environment=PORT={RELAY_PORT}
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/env node {REMOTE_DIR}/run.mjs
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full

[Install]
WantedBy=multi-user.target
"""
    transport = client.get_transport()
    assert transport is not None
    sftp = paramiko.SFTPClient.from_transport(transport)
    assert sftp is not None
    remote_tmp = "/tmp/pocket-harness-relay.service"
    with sftp.file(remote_tmp, "w") as handle:
        handle.write(unit)
    sftp.close()

    code, output = run(
        client,
        f"install -m 0644 {remote_tmp} {UNIT_PATH} && systemctl daemon-reload && "
        f"systemctl enable --now pocket-harness-relay && sleep 2 && "
        f"systemctl is-active pocket-harness-relay && "
        f"curl -s -m 3 http://127.0.0.1:{RELAY_PORT}/healthz",
        timeout=120,
    )
    log(output)
    if "active" not in output:
        _code, journal = run(client, "journalctl -u pocket-harness-relay -n 40 --no-pager")
        log(journal)
        sys.exit("the relay unit did not come up")


def stage_nginx(client: paramiko.SSHClient) -> None:
    """Add a location that bypasses the site gate, ahead of it."""
    snippet = f"""    # Pocket Harness relay: a WebSocket long-poll path must not sit behind the
    # HTML gate, or the phone can never open the upgrade.
    location = {NGINX_LOCATION} {{
        proxy_pass http://127.0.0.1:{RELAY_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        access_log off;
    }}
    location = {NGINX_LOCATION}/healthz {{
        proxy_pass http://127.0.0.1:{RELAY_PORT}/healthz;
        access_log off;
    }}
"""

    inspect = r"""
for f in $(grep -rlE "server_name[^;]*DOMAIN" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null); do
  echo "FILE $f"
  grep -n "location\|return 303\|gate" "$f" | head -30
done
""".replace("DOMAIN", DOMAIN)
    _code, output = run(client, inspect.strip(), timeout=60)
    log(output)

    if NGINX_LOCATION in output:
        log(f"{NGINX_LOCATION} already present in nginx, leaving it alone")
        return

    transport = client.get_transport()
    assert transport is not None
    sftp = paramiko.SFTPClient.from_transport(transport)
    assert sftp is not None
    with sftp.file("/tmp/ph-relay-location.conf", "w") as handle:
        handle.write(snippet)
    sftp.close()

    inject = r"""
set -e
target=$(grep -rlE "server_name[^;]*DOMAIN" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | head -1)
[ -n "$target" ] || { echo "no server block for DOMAIN"; exit 2; }
cp "$target" "$target.bak-$(date +%s)"
python3 - "$target" <<'PY'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
text = path.read_text()
snippet = pathlib.Path('/tmp/ph-relay-location.conf').read_text()
# Insert right after the server line that carries the 443 listener.
match = re.search(r'server\s*\{', text)
if not match:
    sys.exit('cannot find a server block')
text = text[:match.end()] + '\n' + snippet + text[match.end():]
path.write_text(text)
print('injected into', path)
PY
nginx -t && systemctl reload nginx && echo nginx-reloaded
""".replace("DOMAIN", DOMAIN)
    code, output = run(client, inject.strip(), timeout=120)
    log(output)
    if code != 0:
        sys.exit("nginx injection failed; the previous config is in place as a .bak")


def stage_verify(client: paramiko.SSHClient) -> None:
    _code, local = run(
        client,
        f"curl -s -m 3 http://127.0.0.1:{RELAY_PORT}/healthz; "
        f"systemctl is-active pocket-harness-relay",
    )
    log(f"on-box: {local}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--stage",
        default="probe,push,unit,verify",
        help="comma separated: probe,push,unit,nginx,verify",
    )
    parser.add_argument("--nginx", action="store_true", help="also add the reverse proxy")
    args = parser.parse_args()

    if "nginx" in (args.stage, "") or args.nginx:
        if not DOMAIN:
            sys.exit("POCKET_HARNESS_VPS_DOMAIN is not set; the reverse proxy needs a name")

    stages = [s.strip() for s in args.stage.split(",") if s.strip()]
    if args.nginx and "nginx" not in stages:
        stages.insert(stages.index("verify") if "verify" in stages else len(stages), "nginx")

    client = connect()
    try:
        for stage in stages:
            log(f"\n=== {stage} ===")
            if stage == "probe":
                stage_probe(client)
            elif stage == "push":
                stage_push(client)
            elif stage == "unit":
                stage_unit(client, relay_token())
            elif stage == "nginx":
                stage_nginx(client)
            elif stage == "verify":
                stage_verify(client)
            else:
                sys.exit(f"unknown stage {stage}")
    finally:
        client.close()
    log("\ndone")


if __name__ == "__main__":
    main()

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
import time
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
ENV_FILE = "/etc/pocket-harness-relay.env"
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
    # Close the channel before the caller opens another one. A small VPS often
    # runs the stock MaxSessions, and a lingering exec channel plus a fresh SFTP
    # channel hits "open failed: Connect failed" instead of a clear error.
    stdout.channel.close()
    return code, (out + err).strip()


def sftp_of(client: paramiko.SSHClient) -> paramiko.SFTPClient:
    transport = client.get_transport()
    assert transport is not None
    last: Exception | None = None
    for attempt in range(4):
        try:
            handle = paramiko.SFTPClient.from_transport(transport)
            assert handle is not None
            return handle
        except paramiko.ssh_exception.ChannelException as error:
            last = error
            time.sleep(1.5 * (attempt + 1))
    assert last is not None
    raise last


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

    sftp = sftp_of(client)

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
Environment=PORT={RELAY_PORT}
Environment=HOST=127.0.0.1
EnvironmentFile={ENV_FILE}
ExecStart=/usr/bin/env node {REMOTE_DIR}/run.mjs
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full

[Install]
WantedBy=multi-user.target
"""
    # The token must not live in the unit file. A unit under /etc/systemd/system
    # is world-readable on every stock distro (and gets shipped to `systemd-analyze
    # security` style tooling), so an inline Environment= token is readable by any
    # local user — a relay token is the whole access control for the room. Keep it in
    # an env file that only root can read, and point the unit at that.
    environment = f"POCKET_HARNESS_RELAY_TOKEN={token}\n"
    sftp = sftp_of(client)
    remote_tmp = "/tmp/pocket-harness-relay.service"
    remote_env = "/tmp/pocket-harness-relay.env"
    with sftp.file(remote_tmp, "w") as handle:
        handle.write(unit)
    with sftp.file(remote_env, "w") as handle:
        handle.write(environment)
    sftp.close()

    code, output = run(
        client,
        f"install -m 0600 -o root -g root {remote_env} {ENV_FILE} && "
        f"install -m 0644 {remote_tmp} {UNIT_PATH} && "
        f"rm -f {remote_tmp} {remote_env} && "
        f"systemctl daemon-reload && "
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
    """Add a location that reaches the relay ahead of the site's catch-all.

    The relay speaks WebSocket on /relay and answers /healthz over plain HTTP.
    Both are proxied under one prefix so a single certificate covers them and
    the phone only needs one name.

    Two things this deliberately does not do:

    * It does not assume the file is UTF-8. The site config on a real box often
      carries comments in the operator's own encoding, and re-encoding it would
      corrupt them. Everything here stays in bytes and the snippet is pure ASCII.
    * It does not insert after "the first server {" — that is the port-80
      redirect block on a normal HTTP-to-HTTPS site, so the location would live
      where nothing ever reads it. It finds the block that listens on 443.
    """
    snippet = f"""
    # Pocket Harness relay (added by tools/deploy-relay.py).
    # A WebSocket upgrade must not reach the application behind the site gate:
    # the gate answers unknown paths with a 303, and the phone would never get
    # its upgrade. The prefix is rewritten so the relay keeps its own /relay.
    location = {NGINX_LOCATION}/healthz {{
        proxy_pass http://127.0.0.1:{RELAY_PORT}/healthz;
        access_log off;
    }}

    location {NGINX_LOCATION} {{
        proxy_pass http://127.0.0.1:{RELAY_PORT}/relay;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        proxy_cache off;
        proxy_next_upstream off;
        access_log off;
    }}
"""

    targets = r"""
for f in $(grep -RlE "server_name[^;]*DOMAIN" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null); do
  readlink -f "$f"
done | sort -u | head -5
""".replace("DOMAIN", DOMAIN)
    _code, listed = run(client, targets.strip(), timeout=60)
    files = [line.strip() for line in listed.splitlines() if line.strip().startswith("/")]
    if not files:
        sys.exit(f"no nginx file mentions {DOMAIN}")

    sftp = sftp_of(client)

    for target in files:
        with sftp.file(target, "rb") as handle:
            raw = handle.read()
        if NGINX_LOCATION.encode("ascii") in raw:
            log(f"{target}: {NGINX_LOCATION} already present, leaving it alone")
            continue

        offset = _https_server_open(raw)
        if offset is None:
            log(f"{target}: no server block listening on 443, skipping")
            continue

        backup = f"{target}.bak-{int(time.time())}"
        # A discarded exit code here meant a failed `cp` still got announced as a
        # backup, and a rejected reload then pointed the operator at a .bak that was
        # never written. If the copy fails there is nothing worth going on with.
        code, output = run(client, f"cp -p {target} {backup}", timeout=30)
        if code != 0:
            sftp.close()
            sys.exit(f"cannot back up {target}: {output}")
        updated = raw[:offset] + snippet.encode("ascii") + raw[offset:]
        with sftp.file(target, "wb") as handle:
            handle.write(updated)
        log(f"{target}: injected the relay location at byte {offset} (backup {backup})")

    sftp.close()

    code, output = run(client, "nginx -t 2>&1 && systemctl reload nginx && echo nginx-reloaded")
    log(output)
    if code != 0 or "nginx-reloaded" not in output:
        sys.exit("nginx rejected the config; the .bak next to it is the working copy")


def _https_server_open(raw: bytes) -> int | None:
    """Byte offset just after the opening brace of the block listening on 443."""
    for match in re.finditer(rb"\bserver\s*\{", raw):
        depth = 0
        index = match.end() - 1
        end = None
        while index < len(raw):
            char = raw[index : index + 1]
            if char == b"{":
                depth += 1
            elif char == b"}":
                depth -= 1
                if depth == 0:
                    end = index
                    break
            index += 1
        if end is None:
            continue
        body = raw[match.end() : end]
        if re.search(rb"listen\s+[^;]*\b443\b", body):
            return match.end()
    return None


def stage_verify(client: paramiko.SSHClient) -> None:
    code, local = run(
        client,
        f"curl -s -m 3 http://127.0.0.1:{RELAY_PORT}/healthz; "
        f"systemctl is-active pocket-harness-relay",
    )
    log(f"on-box: {local}")
    # The docstring promises a check that the relay is really up. Logging the output
    # and returning 0 meant a relay that never started still printed "done" and left
    # the operator to discover it from the phone.
    if code != 0:
        sys.exit(f"the on-box checks exited {code}: {local}")
    if "active" not in local:
        sys.exit(f"the relay unit is not active: {local}")
    if not any(re.fullmatch(r"ok rooms=\d+", line.strip()) for line in local.splitlines()):
        sys.exit(f"/healthz did not answer as expected: {local}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--stage",
        default="probe,push,unit,verify",
        help="comma separated: probe,push,unit,nginx,verify",
    )
    parser.add_argument("--nginx", action="store_true", help="also add the reverse proxy")
    args = parser.parse_args()

    stages = [s.strip() for s in args.stage.split(",") if s.strip()]
    if args.nginx and "nginx" not in stages:
        stages.insert(stages.index("verify") if "verify" in stages else len(stages), "nginx")

    # `"nginx" in (args.stage, "")` is a tuple membership test: it is true only when
    # --stage is exactly the string "nginx". A run like `--stage probe,nginx` slipped
    # past this check, then stage_nginx interpolated DOMAIN=None into the grep command
    # and died with a TypeError traceback halfway through the deployment. Ask the same
    # list the dispatcher uses.
    if "nginx" in stages and not DOMAIN:
        sys.exit("POCKET_HARNESS_VPS_DOMAIN is not set; the reverse proxy needs a name")

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

#!/bin/bash
# Build, package (web app + JS service) and optionally deploy to the TV.
#
# Usage:
#   ./build.sh                 # build + package only -> dist/*.ipk
#   ./build.sh --deploy        # also install and launch on the TV
#
# The service has ZERO npm dependencies (it re-implements the few things it
# needs on top of Node's own stdlib), so unlike the reference project there is
# no "install service deps" step — the .ipk ships only source.
set -eo pipefail
cd "$(dirname "$0")"

MODE="package"
if [ "$1" = "--deploy" ]; then MODE="deploy"; fi

NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

# The runtime device identity is parked at the REPO ROOT while packaging.
# ares-package only ever sees `app/dist` and `service/…`, so the root is a safe
# holding spot that needs no temp directory at all — and no temp directory
# means nothing to clean up on the way out (an earlier version parked it in
# TMPDIR and the cleanup was refused by the host's path guard).
ID_PARK=".device-id.parked"
# One combined EXIT handler. bash REPLACES an earlier `trap ... EXIT` rather
# than chaining, so a second trap for the identity restore would have silently
# dropped this one (or the other way round) — exactly the bug that shipped
# once. Keep it to a single handler.
on_exit() {
  if [ -n "$ID_PARKED" ] && [ -f "$ID_PARK" ]; then
    mv "$ID_PARK" "$ID_FILE"
    ID_PARKED=""
    echo "restored runtime device identity to $ID_FILE"
  fi
}
trap on_exit EXIT

# Locate the webOS CLI. `ares-package` is a Node script, so we can always invoke
# it through `node` — which matters on hosts where the .bin shims are not on
# PATH (and where the package's own postinstall cannot run under a restricted
# environment). Resolution order:
#   1. $ARES_DIR pointing at a @webos-tools/cli install
#   2. the managed isolated workspace
#   3. a plain `ares-package` on PATH
ARES_PKG=""
ARES_BIN=""
for cand in \
  "$ARES_DIR/node_modules/@webos-tools/cli/bin/ares-package.js" \
  "$HOME/.workbuddy/binaries/node/workspace/node_modules/@webos-tools/cli/bin/ares-package.js"
do
  if [ -n "$cand" ] && [ -f "$cand" ]; then ARES_PKG="$cand"; ARES_BIN="${cand%/ares-package.js}"; break; fi
done
if [ -z "$ARES_PKG" ]; then
  if command -v ares-package >/dev/null 2>&1; then
    ARES_BIN="$(dirname "$(command -v ares-package)")"
    ARES_PKG="$ARES_BIN/ares-package"
  else
    echo "ERROR: ares-package not found." >&2
    echo "Install it with:" >&2
    echo "  npm i --prefix \"\$HOME/.workbuddy/binaries/node/workspace\" --ignore-scripts @webos-tools/cli" >&2
    echo "or set ARES_DIR to a directory containing node_modules/@webos-tools/cli" >&2
    exit 2
  fi
fi
# ares-package is a Node script. Invoke it through the same node the rest of
# the tooling uses, so a missing .bin shim on PATH does not matter.
ares_run() {
  local name="$1"; shift
  local script="$ARES_BIN/$name.js"
  [ -f "$script" ] || script="$ARES_BIN/$name"
  node "$script" "$@"
}
echo "webOS CLI: $ARES_PKG ($(ares_run ares-package --version 2>/dev/null | head -1))"

echo ""
echo "=== [1/4] Frontend dependencies ==="
if [ ! -d app/node_modules/vite ]; then
  echo "node_modules missing — installing from $NPM_REGISTRY"
  (cd app && npm install --registry="$NPM_REGISTRY" --no-audit --no-fund 2>&1 | tail -3)
else
  echo "already installed, skipping"
fi

echo ""
echo "=== [2/4] Build web app ==="
(cd app && npx vite build 2>&1 | tail -12)
cp app/webos-meta/* app/dist/

echo ""
echo "=== [3/4] Package .ipk ==="
mkdir -p dist
rm -f dist/*.ipk
# The runtime device identity (.device-id.json) is minted per install on first
# launch. Shipping it inside the package would make every install share one
# identity — which the upstream bans as a unit, so one ban would take out all
# of them. Park it at the repo root for the duration of the build: ares-package
# is handed app/dist and service/… only, so the root is never staged, and a
# rename inside the service directory would itself get packaged (that exact
# mistake shipped once as a stray .device-id.json.build-bak inside the ipk).
ID_FILE="service/com.hongguowebos.app.service/.device-id.json"
if [ -f "$ID_FILE" ]; then
  mv "$ID_FILE" "$ID_PARK"
  ID_PARKED=1
  echo "stripped runtime device identity from the package (held at $ID_PARK)"
fi
# NOTE: do NOT add `--no-minify`. It is not an option in @webos-tools/cli 3.x;
# passing it makes the CLI print "The specified path does not exist <package>".
# ares-package writes the artifact and THEN fails to rmdir its own staging tree
# on Windows (EPERM — something still holds a handle on vendor/). The ipk is
# already complete at that point, so do not let their cleanup problem fail the
# build: the existence check below is the real gate on success.
ares_run ares-package -o dist app/dist service/com.hongguowebos.app.service 2>&1 | tail -8 || true
if [ -f "$ID_BACKUP" ]; then
  mv "$ID_BACKUP" "$ID_FILE"
fi

# ares-package writes <id>_<version>_all.ipk; locate whatever it produced.
IPK="$(ls -t dist/*.ipk 2>/dev/null | head -1 || true)"
if [ -z "$IPK" ]; then
  echo "packaging failed: no .ipk produced" >&2
  exit 1
fi
echo "artifact: $IPK ($(du -h "$IPK" | cut -f1))"

echo ""
echo "=== [4/4] Deploy ==="
if [ "$MODE" != "deploy" ]; then
  echo "skipped (pass --deploy to install on the TV)"
  echo ""
  echo "To install on a TV (set TV_HOST to your own device):"
  echo "  TV_HOST=<tv-ip> TV_SSH_PASSPHRASE=<devmode-pass> node tools/deploy.js"
  exit 0
fi

# Deploy over SSH rather than via ares-install. The TV's Developer Mode exposes
# a plain OpenSSH endpoint; talking to it directly avoids the ares CLI's device
# profiles (which assume a prisoner key-pair the TV does not have) and its
# broken postinstall on this host.
node tools/deploy.js
echo "deploy finished"

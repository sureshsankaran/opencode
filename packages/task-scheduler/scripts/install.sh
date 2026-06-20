#!/usr/bin/env bash
#
# install.sh — install (or uninstall) the opencode task-scheduler as an always-on
# launchd agent on macOS, so scheduled tasks fire 24/7 even when no browser tab
# is open.
#
# Usage:
#   ./scripts/install.sh            # install + start
#   ./scripts/install.sh uninstall  # stop + remove
#   ./scripts/install.sh status     # show status + recent logs
#
set -euo pipefail

LABEL="local.opencode.task-scheduler"
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON="${PACKAGE_DIR}/src/daemon.ts"
TEMPLATE="${PACKAGE_DIR}/scripts/${LABEL}.plist.template"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/.local/share/opencode/log"
LOG_FILE="${LOG_DIR}/task-scheduler.log"

find_bun() {
  if command -v bun >/dev/null 2>&1; then command -v bun; return; fi
  for candidate in "${HOME}/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [[ -x "$candidate" ]]; then echo "$candidate"; return; fi
  done
  echo "error: could not find 'bun' on PATH or in common locations." >&2
  exit 1
}

cmd="${1:-install}"

case "$cmd" in
  install)
    BUN="$(find_bun)"
    BUN_DIR="$(dirname "$BUN")"
    mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR" "${HOME}/.config/opencode"

    echo "Generating ${PLIST_DEST}"
    sed \
      -e "s#__BUN__#${BUN}#g" \
      -e "s#__BUN_DIR__#${BUN_DIR}#g" \
      -e "s#__DAEMON__#${DAEMON}#g" \
      -e "s#__PACKAGE_DIR__#${PACKAGE_DIR}#g" \
      -e "s#__HOME__#${HOME}#g" \
      "$TEMPLATE" > "$PLIST_DEST"

    # Reload if already present.
    if launchctl list | grep -q "$LABEL"; then
      echo "Unloading existing agent"
      launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    fi

    echo "Loading agent"
    launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
    launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true

    sleep 2
    echo
    echo "Installed. Control API: http://127.0.0.1:5055"
    echo "Logs: ${LOG_FILE}"
    echo
    echo "Status:"
    launchctl list | grep "$LABEL" || echo "  (not yet listed; check the log)"
    ;;

  uninstall)
    echo "Stopping and removing ${LABEL}"
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    rm -f "$PLIST_DEST"
    echo "Removed ${PLIST_DEST}"
    echo "Note: your tasks are preserved at ${HOME}/.config/opencode/tasks.json"
    ;;

  status)
    echo "launchd:"
    launchctl list | grep "$LABEL" || echo "  not loaded"
    echo
    echo "control API:"
    curl -s --max-time 3 http://127.0.0.1:5055/status || echo "  not responding"
    echo
    echo
    echo "recent log (${LOG_FILE}):"
    tail -n 20 "$LOG_FILE" 2>/dev/null || echo "  no log yet"
    ;;

  *)
    echo "Usage: $0 [install|uninstall|status]" >&2
    exit 1
    ;;
esac

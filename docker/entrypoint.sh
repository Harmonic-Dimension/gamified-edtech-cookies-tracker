#!/usr/bin/env bash
set -euo pipefail

# A virtual X display is always started: headless runs ignore it, and
# interactive (headed) runs need it. With ENABLE_VNC=1 (the default) the display
# is also published over noVNC on port 6080, so an interactive audit session can
# be watched and driven from the host browser at http://localhost:6080/vnc.html
: "${DISPLAY:=:99}"
: "${ENABLE_VNC:=1}"
: "${SCREEN_GEOMETRY:=1440x900x24}"

if ! pgrep -f "Xvfb ${DISPLAY}" >/dev/null 2>&1; then
  Xvfb "${DISPLAY}" -screen 0 "${SCREEN_GEOMETRY}" -nolisten tcp &
  for _ in $(seq 1 50); do
    if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
fi

if [ "${ENABLE_VNC}" = "1" ]; then
  fluxbox >/dev/null 2>&1 &
  x11vnc -display "${DISPLAY}" -forever -shared -nopw -quiet -rfbport 5900 >/dev/null 2>&1 &
  websockify --web=/usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
  echo "noVNC available on http://localhost:6080/vnc.html (view-only unless you interact)"
fi

# The audit writes into /app/data; make sure it exists when a fresh volume is mounted.
mkdir -p /app/data/audits /app/data/trackers

exec "$@"

#!/bin/bash
export WAYLAND_DISPLAY=wayland-0
export XDG_RUNTIME_DIR=/run/user/1000
echo "WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
ls -la /run/user/1000/wayland* 2>&1
echo "---"
wvkbd-mobintl --hidden -H 500 -R 12 --bg 1e293bee --fg e2e8f0cc --fg-sp 94a3b8cc --text e2e8f0ff --text-sp 94a3b8ff --press 334155cc --press-sp 475569cc >/tmp/wvkbd.log 2>&1 &
WPID=$!
sleep 2
echo "PID=$WPID"
pgrep -a wvkbd || echo NONE
cat /tmp/wvkbd.log 2>/dev/null || echo NOLOG
kill $WPID 2>/dev/null

#!/bin/bash
export WAYLAND_DISPLAY=wayland-0
export XDG_RUNTIME_DIR=/run/user/1000
case "$1" in
  show)
    if ! pgrep -x wvkbd-mobintl >/dev/null 2>&1; then
      setsid wvkbd-mobintl --hidden -H 500 -R 12 --bg 1e293bee --fg e2e8f0cc --fg-sp 94a3b8cc --text e2e8f0ff --text-sp 94a3b8ff --press 334155cc --press-sp 475569cc >/dev/null 2>&1 &
      sleep 0.5
    fi
    pkill -USR1 -x wvkbd-mobintl 2>/dev/null
    ;;
  hide)
    pkill -USR2 -x wvkbd-mobintl 2>/dev/null
    ;;
esac

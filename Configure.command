#!/bin/zsh
set -e

if ! /usr/bin/curl -fs --max-time 2 http://127.0.0.1:7331/health.json >/dev/null; then
  print -u2 'Open Start.command first, then open Configure.command again.'
  exit 1
fi
/usr/bin/open 'http://127.0.0.1:7331/configure'

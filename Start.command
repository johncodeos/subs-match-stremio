#!/bin/zsh
set -e
cd -- "${0:A:h}"

bundled_node='/Applications/ChatGPT.app/Contents/Resources/node'
if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] < 22)' ; then
  node_path="$(command -v node)"
elif [[ -x "$bundled_node" ]]; then
  node_path="$bundled_node"
else
  print -u2 'Install Node.js 22 or later, then run Start.command again.'
  exit 1
fi

if [[ -f .env ]]; then
  exec "$node_path" --env-file=.env src/server.js
fi
exec "$node_path" src/server.js

#!/bin/sh
set -eu

cd "$(dirname "$0")"

# Every deploy gets its own cache name, so the service worker ALWAYS treats
# a new deploy as an update (installs, activates, purges every old cache)
# instead of relying on someone remembering to bump CACHE_NAME by hand.
STAMP="$(date -u +%Y%m%d%H%M%S)"
sed -i.bak "s/const CACHE_NAME = '[^']*'/const CACHE_NAME = 'money-money-analyzer-${STAMP}'/" sw.js
rm -f sw.js.bak

npx --yes netlify-cli deploy --prod --dir=. --functions=netlify/functions
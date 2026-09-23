#!/bin/sh
set -eu

cd "$(dirname "$0")"
npx --yes netlify-cli deploy --prod --dir=. --functions=netlify/functions
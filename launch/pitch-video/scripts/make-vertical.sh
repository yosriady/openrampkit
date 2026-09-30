#!/usr/bin/env bash
# Generates the vertical project vertical/index.html (1080x1920) from index.html.
# Layout switches on #root[data-width="1080"]; assets are shared through a symlink.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p vertical
[[ -e vertical/assets ]] || ln -s ../assets vertical/assets
sed -e 's/data-width="1920"/data-width="1080"/' \
    -e 's/data-height="1080"/data-height="1920"/' \
    -e 's/content="width=1920, height=1080"/content="width=1080, height=1920"/' \
    -e 's/<title>OpenRampKit pitch (15s)<\/title>/<title>OpenRampKit pitch (15s, vertical)<\/title>/' \
    index.html > vertical/index.html
echo "wrote vertical/index.html"

#!/usr/bin/env bash
# Build the static site: the docs, with the playground at /playground/.
# DOCS_BASE sets the public path (default `/`; `/openrampkit/` for GitHub Pages).
# Set SKIP_PACKAGES=1 when the packages are already built.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${SKIP_PACKAGES:-}" != "1" ]; then pnpm build; fi
pnpm docs:build
pnpm --filter playground build
rm -rf docs/.vitepress/dist/playground
cp -R examples/playground/dist docs/.vitepress/dist/playground
echo "Site ready in docs/.vitepress/dist (base: ${DOCS_BASE:-/})"

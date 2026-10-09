#!/usr/bin/env node
// `pnpm release` publishes to npm. Only the Release workflow may run it, so that each
// package gets an npm provenance statement and nobody publishes from a laptop by accident.
// Read docs/guide/releases.md.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_WORKFLOW !== 'Release') {
  console.error('pnpm release runs only in the Release workflow (.github/workflows/release.yml).')
  console.error('To release, merge the "Version packages" pull request. Read docs/guide/releases.md.')
  process.exit(1)
}

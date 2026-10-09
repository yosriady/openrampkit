# Changesets

Add a changeset for every user-facing change: `pnpm changeset`.

Do not release by hand. The Release workflow (`.github/workflows/release.yml`) opens the **Version packages** pull request and publishes to npm when a maintainer merges it. Read `docs/guide/releases.md`.

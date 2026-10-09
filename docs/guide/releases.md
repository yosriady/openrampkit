# Releases and versions

This page tells you how OpenRampKit versions its packages, what a version number promises, and how a release gets to npm.

## One version for all packages

All `@openrampkit/*` packages have the same version. When one package changes, all packages get the new version. This makes upgrades simple:

- Install the same version of each `@openrampkit/*` package that you use.
- When you upgrade one package, upgrade all of them.

The first release on npm is `0.1.0`.

## Stability policy (0.x)

OpenRampKit is before 1.0. The APIs can change. We follow [semantic versioning](https://semver.org) with the 0.x rules:

| Change | Example | What it can contain |
|---|---|---|
| Minor | `0.1.0` to `0.2.0` | New features and **breaking changes**. |
| Patch | `0.1.0` to `0.1.1` | Bug fixes and security fixes. New options that do not break your code. |

Rules that we follow:

- A breaking change goes only into a minor release. The changelog tells you what breaks and how to change your code.
- When we can, we keep the old API for one minor release and mark it `@deprecated`.
- We do not publish a major version (`1.0.0`) before the APIs are stable. We will tell you before 1.0.
- We fix security problems in the latest minor version. See [SECURITY.md](https://github.com/yosriady/openrampkit/blob/main/SECURITY.md).

What you should do:

- Use a caret range: `"@openrampkit/server": "^0.1.0"`. For a 0.x version, npm, pnpm and yarn read `^0.1.0` as `>=0.1.0 <0.2.0`. You get patches, but not the next minor.
- Read the changelog before you change to a new minor. Each package has a `CHANGELOG.md`, and each release has a GitHub release.
- After you upgrade, run your tests with the [mock adapter](../adapters/mock.md). Then deploy to production.

## How a release happens

Releases run in GitHub Actions only. Nobody publishes from a laptop. The workflow is [`.github/workflows/release.yml`](https://github.com/yosriady/openrampkit/blob/main/.github/workflows/release.yml).

1. A contributor adds a changeset to a pull request (`pnpm changeset`). The changeset names the packages, the bump (`patch` or `minor`) and a note for users.
2. When the pull request merges into `main`, the Release workflow opens or updates a pull request with the title **Version packages**. That pull request sets the new versions and writes the changelogs.
3. A maintainer reviews the **Version packages** pull request and merges it.
4. The Release workflow sees versions that are not on npm. It builds, typechecks, tests and smoke tests the packages. Then it publishes them to npm with provenance, pushes a git tag for each package and makes a GitHub release.

`pnpm release` stops with an error when it runs outside the Release workflow.

## Provenance

Each package that the Release workflow publishes has an [npm provenance statement](https://docs.npmjs.com/generating-provenance-statements). The statement links the package on npm to the source commit and to the workflow run that built it. Sigstore signs it, and a public transparency log records it.

To check the packages in your project:

```bash
npm audit signatures
```

The npm page of each package also shows the source commit and the build.

## Dependency updates and code scanning

- [Renovate](https://docs.renovatebot.com) opens pull requests on Monday mornings (UTC). One pull request has all npm minor and patch updates. One pull request has all GitHub Actions updates. Each major update has its own pull request. Renovate waits 3 days after a release before it suggests it. Security updates come at any time. The config is [`renovate.json`](https://github.com/yosriady/openrampkit/blob/main/renovate.json).
- All workflows pin each action to a full commit SHA, with the version in a comment. Renovate keeps the SHA and the comment up to date.
- Each workflow has read-only permissions by default. A job gets more permissions only when it needs them.
- [CodeQL](https://codeql.github.com) scans the TypeScript, the JavaScript and the workflows on each pull request, on each push to `main` and each week.

## For maintainers: one-time setup

Do these steps once, before the first release.

### 1. Create the npm organization

1. Sign in to [npmjs.com](https://www.npmjs.com) with an account that has two-factor authentication.
2. Create the free organization `openrampkit`. The packages publish as `@openrampkit/*`.

### 2. Let GitHub Actions open pull requests

In the repository, go to **Settings > Actions > General > Workflow permissions**. Select **Allow GitHub Actions to create and approve pull requests**. Without this setting, the Release workflow cannot open the **Version packages** pull request.

### 3. Add the npm token for the first release

npm can add a trusted publisher only to a package that exists. Thus the first release (`0.1.0`) needs a token.

1. On npmjs.com, create a **granular access token**:
   - Permissions: **Read and write**, for the `openrampkit` organization (all its packages).
   - Select **Bypass two-factor authentication** so that CI can publish.
   - Expiration: a short time, for example 7 days.
2. In the repository, go to **Settings > Environments**. Open the `npm` environment, or create it.
   - Under **Deployment branches and tags**, allow only `main`.
   - Optional: add yourself as a **required reviewer**. Then each publish waits for your approval.
3. Add the token as the environment secret `NPM_TOKEN`.

If `NPM_TOKEN` is not set, the publish job writes a warning (`npm publish skipped`) and publishes nothing.

### 4. Release 0.1.0

1. Merge the **Version packages** pull request. It sets all packages to `0.1.0`.
2. Watch the **Publish to npm** job. Make sure that each package on npm shows a provenance statement.

A pull request that the workflow opens does not start the CI workflow (a GitHub rule for `GITHUB_TOKEN`). To run CI on the **Version packages** pull request, close it and open it again. The publish job also runs the build, the tests and the smoke test before it publishes.

### 5. Change to trusted publishing and delete the token

After `0.1.0` is on npm, change to [trusted publishing](https://docs.npmjs.com/trusted-publishers). Then no long-lived token exists.

1. For each `@openrampkit/*` package on npmjs.com, open **Settings > Trusted publishing** and add GitHub Actions:
   - Organization or user: `yosriady`
   - Repository: `openrampkit`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
2. In the repository, add the variable `NPM_TRUSTED_PUBLISHING` with the value `true` (**Settings > Secrets and variables > Actions > Variables**).
3. Delete the `NPM_TOKEN` secret, and revoke the token on npmjs.com.
4. Optional: in the package settings on npm, select **Require two-factor authentication and disallow tokens**.

With trusted publishing, pnpm gets a short-lived npm token through OIDC for each publish. npm adds the provenance statement automatically.

### Credentials order

| `NPM_TOKEN` secret | `NPM_TRUSTED_PUBLISHING` variable | Result |
|---|---|---|
| Set | Any value | Publish with the token and provenance |
| Not set | `true` | Publish with trusted publishing (OIDC) and provenance |
| Not set | Not `true` | Publish nothing. The job writes a warning. |

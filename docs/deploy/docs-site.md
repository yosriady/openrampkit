# Host the docs and playground

The docs site and the [playground](../guide/playground.md) are static files. They need no server, no secrets and no provider accounts.

## Build

```bash
pnpm install
pnpm site:build
```

This command builds the packages, the docs and the playground. The output is in `docs/.vitepress/dist`. The playground is in `docs/.vitepress/dist/playground/`.

## The base path

The `DOCS_BASE` environment variable sets the public path of the site. The docs and the playground both use it.

| Host | `DOCS_BASE` |
|---|---|
| Vercel (the public site, `https://openrampkit-getformo.vercel.app`) | Do not set it (the default is `/`) |
| Custom domain, or Cloudflare Pages | Do not set it |
| GitHub Pages project site (`https://yosriady.github.io/openrampkit/`) | `/openrampkit/` |

```bash
DOCS_BASE=/openrampkit/ pnpm site:build
```

## Vercel

The public site at [openrampkit-getformo.vercel.app](https://openrampkit-getformo.vercel.app) runs on Vercel.

1. Import the repository as a new Vercel project.
2. Set **Framework Preset** to **Other**.
3. Set **Build Command** to `pnpm site:build`.
4. Set **Output Directory** to `docs/.vitepress/dist`.
5. Do not set `DOCS_BASE`.

The `vercel.json` file at the repository root sets `cleanUrls: true`. Then `/guide/why` serves `guide/why.html`, as the docs links expect.

Vercel deploys each push to `main`. Commits must be signed.

## GitHub Pages

The workflow `.github/workflows/docs.yml` deploys the site on each push to `main`. You can also start it by hand from the **Actions** tab.

Do these steps one time:

1. Go to **Settings > Pages**.
2. Set **Source** to **GitHub Actions**.

GitHub Pages for a private repository needs a paid plan. On a free plan, make the repository public.

For a custom domain, set the domain in **Settings > Pages**. Then remove `DOCS_BASE` from the workflow.

## Cloudflare Pages

1. Create a Pages project and connect the repository.
2. Set **Build command** to `pnpm site:build`.
3. Set **Build output directory** to `docs/.vitepress/dist`.
4. Set the environment variable `NODE_VERSION` to `22`.

Do not set `DOCS_BASE`. Cloudflare Pages serves the site at the root.

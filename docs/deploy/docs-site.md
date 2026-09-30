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
| GitHub Pages project site (`https://yosriady.github.io/openrampkit/`) | `/openrampkit/` |
| Custom domain, or Cloudflare Pages | Do not set it (the default is `/`) |

```bash
DOCS_BASE=/openrampkit/ pnpm site:build
```

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

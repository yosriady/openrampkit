import { defineConfig } from 'vite'

// The playground is served under the docs site, at `{DOCS_BASE}playground/`.
// DOCS_BASE is `/openrampkit/` on GitHub Pages and `/` (the default) on a custom domain or Cloudflare Pages.
const docsBase = process.env.DOCS_BASE ?? '/'

export default defineConfig({
  base: `${docsBase.replace(/\/?$/, '/')}playground/`,
  build: { outDir: 'dist', target: 'es2022' },
})

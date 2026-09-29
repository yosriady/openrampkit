import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  // Next.js App Router: everything here uses hooks, so mark the bundle as a client module.
  banner: { js: "'use client'" },
  external: ['react', '@openrampkit/web', '@openrampkit/web/theme', '@openrampkit/client', '@openrampkit/core'],
})

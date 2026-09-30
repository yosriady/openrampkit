import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  external: ['vue', '@openrampkit/web', '@openrampkit/web/theme', '@openrampkit/client', '@openrampkit/core'],
})

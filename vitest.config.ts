import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@openrampkit\/adapter-(.*)$/, replacement: r('./packages/adapters/$1/src/index.ts') },
      { find: /^@openrampkit\/(core|adapter|server|client|web|react|wagmi)$/, replacement: r('./packages/$1/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**'],
      exclude: ['**/*.test.ts', '**/testctx.ts', '**/types.ts', '**/wallet.ts', '**/icons.ts', '**/styles.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
})

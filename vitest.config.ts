import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Solid ships separate browser and server builds (picked by export conditions).
// Its DOM tests (`*.dom.test.ts`) run in their own project with the browser conditions.
const SOLID_DOM = 'packages/solid/src/**/*.dom.test.ts'

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@openrampkit\/adapter\/testing$/, replacement: r('./packages/adapter/src/testing.ts') },
      { find: /^@openrampkit\/web\/theme$/, replacement: r('./packages/web/src/theme.ts') },
      { find: /^@openrampkit\/adapter-(.*)$/, replacement: r('./packages/adapters/$1/src/index.ts') },
      { find: /^@openrampkit\/(core|adapter|server|client|web|react|wagmi|solana|mcp|vue|svelte|solid)$/, replacement: r('./packages/$1/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**'],
      exclude: ['**/*.test.ts', '**/testctx.ts', '**/testchain.ts', '**/types.ts', '**/wallet.ts', '**/icons.ts', '**/styles.ts'],
      reporter: ['text-summary', 'text'],
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['packages/**/*.test.ts'], exclude: ['**/node_modules/**', SOLID_DOM] },
      },
      {
        extends: true,
        resolve: { conditions: ['browser', 'development'] },
        ssr: { resolve: { conditions: ['browser', 'development'], externalConditions: ['browser', 'development'] } },
        test: {
          name: 'solid-dom',
          include: [SOLID_DOM],
          environment: 'happy-dom',
          server: { deps: { inline: [/solid-js/, /@solidjs\/testing-library/] } },
        },
      },
    ],
  },
})

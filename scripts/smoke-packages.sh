#!/usr/bin/env bash
# Pack every package, install the tarballs into a fresh project, and check that they work as a user
# would install them: ESM, CommonJS, React, Vue, Svelte and Solid SSR, and strict TypeScript (nodenext and bundler).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/packs" "$WORK/app"
cd "$ROOT"
pnpm -r --filter './packages/**' exec pnpm pack --pack-destination "$WORK/packs" >/dev/null
cd "$WORK/app"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install --no-audit --no-fund "$WORK"/packs/*.tgz react@19 react-dom@19 typescript@5 @types/react@19 lit viem @wagmi/core vue@3 svelte@5 solid-js@1 >/dev/null
cat > smoke.mjs <<'JS'
import { createOpenRamp } from '@openrampkit/server'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { createOpenRampClient, DepositController } from '@openrampkit/client'
const ramp = createOpenRamp({ secret: 'x'.repeat(40), baseUrl: 'http://l/api', adapters: [mockAdapter({ settleMs: 0 })], logger: { debug() {}, info() {}, warn() {}, error() {} } })
const s = await ramp.sessions.create({ userId: 'u', country: 'ID', destination: { type: 'merchant', currency: 'IDR' } })
const client = createOpenRampClient({ baseUrl: 'http://l/api', fetch: (u, i) => ramp.handle(new Request(String(u), i)) })
const c = new DepositController({ client, clientSecret: s.clientSecret })
await c.start(); await c.selectMethod('qris'); c.setAmount('150000'); await c.submitAmount(); await c.confirm()
if (c.getSnapshot().session.step.surface.kind !== 'QR') throw new Error('expected a QR step')
c.destroy()
console.log('ESM ok')
JS
node smoke.mjs
node -e "const s=require('@openrampkit/server');const c=require('@openrampkit/core');if(typeof s.createOpenRamp!=='function'||typeof c.planPathways!=='function')process.exit(1);console.log('CJS ok')"
node -e "const v=require('@openrampkit/vue');const sv=require('@openrampkit/svelte');const so=require('@openrampkit/solid');if(typeof v.provideOpenRamp!=='function'||typeof sv.createOpenRamp!=='function'||typeof so.OpenRampProvider!=='function')process.exit(1);console.log('CJS framework wrappers ok')"
cat > ssr.mjs <<'JS'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { OpenRampProvider, DepositButton } from '@openrampkit/react'
const html = renderToString(createElement(OpenRampProvider, { baseUrl: '/api' }, createElement(DepositButton, { getClientSecret: async () => 'x' })))
if (!html.includes('button')) throw new Error('SSR failed')
console.log('React SSR ok')
JS
node ssr.mjs
cat > ssr-vue.mjs <<'JS'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { OpenRampProvider, DepositButton, OpenRampEmbedded } from '@openrampkit/vue'
const app = createSSRApp({ render: () => h(OpenRampProvider, { baseUrl: '/api' }, () => [h(DepositButton, { getClientSecret: 'x' }), h(OpenRampEmbedded, { clientSecret: 'x' })]) })
const html = await renderToString(app)
if (!html.includes('<button') || !html.includes('<openramp-modal')) throw new Error('Vue SSR failed: ' + html)
console.log('Vue SSR ok')
JS
node ssr-vue.mjs
cat > ssr-solid.mjs <<'JS'
import { createComponent } from 'solid-js'
import { renderToString } from 'solid-js/web'
import { OpenRampProvider, DepositButton, OpenRampEmbedded } from '@openrampkit/solid'
const html = renderToString(() => createComponent(OpenRampProvider, { baseUrl: '/api', get children() { return [createComponent(DepositButton, { getClientSecret: 'x' }), createComponent(OpenRampEmbedded, { clientSecret: 'x' })] } }))
if (!html.includes('<button') || !html.includes('<openramp-modal')) throw new Error('Solid SSR failed: ' + html)
console.log('Solid SSR ok')
JS
node ssr-solid.mjs
# Svelte: compile a real component (runes mode) for the server, then render it.
cat > Deposit.svelte <<'SVELTE'
<script>
  import { setOpenRamp, depositButton, openRampEmbedded } from '@openrampkit/svelte'
  const ramp = setOpenRamp({ baseUrl: '/api' })
  const isOpen = ramp.isOpen
  let label = $state('Deposit')
</script>
<button use:depositButton={{ ramp, getClientSecret: 'x' }} disabled={$isOpen}>{label}</button>
<openramp-modal use:openRampEmbedded={{ ramp, clientSecret: 'x' }}></openramp-modal>
SVELTE
cat > ssr-svelte.mjs <<'JS'
import { readFileSync, writeFileSync } from 'node:fs'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
const src = readFileSync('Deposit.svelte', 'utf8')
compile(src, { generate: 'client', filename: 'Deposit.svelte' })
writeFileSync('Deposit.server.js', compile(src, { generate: 'server', filename: 'Deposit.svelte' }).js.code)
const { default: Deposit } = await import('./Deposit.server.js')
const { body } = render(Deposit)
if (!body.includes('>Deposit</button>') || !body.includes('<openramp-modal')) throw new Error('Svelte SSR failed: ' + body)
console.log('Svelte SSR ok')
JS
node ssr-svelte.mjs
cat > app.ts <<'TS'
import { createOpenRamp, type CreateSessionInput } from '@openrampkit/server'
import { xendit } from '@openrampkit/adapter-xendit'
import { relay } from '@openrampkit/adapter-relay'
import { wagmiWallet } from '@openrampkit/wagmi'
import type { PublicSession } from '@openrampkit/core'
import { openDeposit, openWithdraw, darkTheme, stripeOnrampRenderer } from '@openrampkit/web'
import { runAdapterConformance } from '@openrampkit/adapter/testing'
const input: CreateSessionInput = { userId: 'u', destination: { type: 'merchant', currency: 'IDR' } }
const ramp = createOpenRamp({ secret: 'x'.repeat(40), baseUrl: 'https://a.test/api', adapters: [relay()] })
export const f = async (): Promise<PublicSession | null> => { await ramp.sessions.create(input); return ramp.sessions.retrieve('x') }
export const g = () => openDeposit({ baseUrl: '/api', clientSecret: 's', theme: darkTheme(), providerRenderers: { stripe: stripeOnrampRenderer() } })
import { OpenRampProvider as VueProvider, provideOpenRamp, useDepositController as useVueController, type OpenRampApi as VueApi } from '@openrampkit/vue'
import { createOpenRamp as createSvelteRamp, depositButton, type OpenRamp as SvelteRamp } from '@openrampkit/svelte'
import { OpenRampProvider as SolidProvider, DepositButton as SolidDepositButton, useOpenRamp as useSolidRamp } from '@openrampkit/solid'
export const svelteRamp: SvelteRamp = createSvelteRamp({ baseUrl: '/api', theme: darkTheme() })
export type Api = VueApi
export { runAdapterConformance, xendit, wagmiWallet, openWithdraw, VueProvider, provideOpenRamp, useVueController, depositButton, SolidProvider, SolidDepositButton, useSolidRamp }
TS
npx tsc --strict --noEmit --module nodenext --moduleResolution nodenext --target es2022 --lib es2022,dom app.ts
npx tsc --strict --noEmit --module esnext --moduleResolution bundler --target es2022 --lib es2022,dom app.ts
echo "TypeScript ok (nodenext, bundler)"

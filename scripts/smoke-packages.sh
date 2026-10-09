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
cat > mcp.mjs <<'JS'
import { createOpenRamp } from '@openrampkit/server'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { createOpenRampMcpServer } from '@openrampkit/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
const ramp = createOpenRamp({ secret: 'x'.repeat(40), baseUrl: 'http://l/api', adapters: [mockAdapter({ settleMs: 0 })], logger: { debug() {}, info() {}, warn() {}, error() {} } })
const server = createOpenRampMcpServer({ connection: { openramp: ramp }, deposit: { destinations: [{ name: 't', chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', address: '0x000000000000000000000000000000000000beef' }] }, maxAmounts: { VND: '2000000' } })
const [a, b] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'smoke', version: '1.0.0' })
await Promise.all([server.connect(a), client.connect(b)])
const r = await client.callTool({ name: 'create_deposit_session', arguments: { country: 'VN' } })
const out = JSON.parse(r.content[0].text)
if (r.isError || !out.pay_url.includes('/pay/')) throw new Error('MCP create_deposit_session failed')
if ((await ramp.handle(new Request(out.pay_url))).status !== 200) throw new Error('pay page failed')
await client.close()
console.log('MCP ok')
JS
node mcp.mjs
node -e "const s=require('@openrampkit/server');const c=require('@openrampkit/core');const m=require('@openrampkit/mcp');if(typeof s.createOpenRamp!=='function'||typeof c.planPathways!=='function'||typeof m.createOpenRampMcpServer!=='function')process.exit(1);console.log('CJS ok')"
cat > solana.mjs <<'JS'
import { solanaWallet, associatedTokenAddress } from '@openrampkit/solana'
import { SOLANA_MAINNET, SOLANA_USDC_MINT, combineWallets, toSplAmount } from '@openrampkit/core'
const w = solanaWallet()
if (w.namespaces[0] !== 'solana' || (await w.getAccounts()).length !== 0) throw new Error('solanaWallet on the server must have no accounts')
const ata = await associatedTokenAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', SOLANA_USDC_MINT)
if (typeof ata !== 'string' || ata.length < 32) throw new Error('ATA derivation failed')
if (toSplAmount('12.5', 6) !== '12500000' || combineWallets(w).id !== 'solana' || !SOLANA_MAINNET.startsWith('solana:')) throw new Error('core Solana helpers failed')
console.log('Solana ok')
JS
node solana.mjs
node -e "const s=require('@openrampkit/solana');if(typeof s.solanaWallet!=='function')process.exit(1);console.log('CJS Solana ok')"
cat > privy.mjs <<'JS'
import { privyWallet, DEFAULT_PRIVY_CHAINS } from '@openrampkit/privy'
const w = privyWallet({ wallet: () => ({ address: '0x0000000000000000000000000000000000000001', chainType: 'ethereum', getEthereumProvider: async () => { throw new Error('no provider call on the server') } }) })
if (w.id !== 'privy' || w.namespaces[0] !== 'eip155' || (await w.getAccounts()).length !== 0) throw new Error('privyWallet on the server must have no accounts')
if (!Array.isArray(DEFAULT_PRIVY_CHAINS) || !DEFAULT_PRIVY_CHAINS.length) throw new Error('DEFAULT_PRIVY_CHAINS is empty')
console.log('Privy ok')
JS
node privy.mjs
node -e "const p=require('@openrampkit/privy');if(typeof p.privyWallet!=='function')process.exit(1);console.log('CJS Privy ok')"
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
import { solanaWallet, type SolanaWalletOptions } from '@openrampkit/solana'
import { combineWallets, type PublicSession, type SolanaTxRequest, type WalletAdapter } from '@openrampkit/core'
const solOpts: SolanaWalletOptions = { walletName: 'Phantom', waitForLast: true }
export const both: WalletAdapter = combineWallets(solanaWallet(solOpts))
export const splTx: SolanaTxRequest = { kind: 'solana', type: 'transfer', to: 'x', mint: 'native', amount: '1', decimals: 9 }
import { openDeposit, openWithdraw, darkTheme, stripeOnrampRenderer } from '@openrampkit/web'
import { runAdapterConformance } from '@openrampkit/adapter/testing'
import { createOpenRampMcpServer, createMcpHttpHandler, type OpenRampMcpConfig } from '@openrampkit/mcp'
const input: CreateSessionInput = { userId: 'u', destination: { type: 'merchant', currency: 'IDR' } }
const ramp = createOpenRamp({ secret: 'x'.repeat(40), baseUrl: 'https://a.test/api', adapters: [relay()] })
export const f = async (): Promise<PublicSession | null> => { await ramp.sessions.create(input); return ramp.sessions.retrieve('x') }
export const g = () => openDeposit({ baseUrl: '/api', clientSecret: 's', theme: darkTheme(), providerRenderers: { stripe: stripeOnrampRenderer() } })
const mcpConfig: OpenRampMcpConfig = { connection: { openramp: ramp }, maxAmounts: { USDC: '10' } }
export const h = () => [createOpenRampMcpServer(mcpConfig), createMcpHttpHandler(mcpConfig, { bearerToken: 'x'.repeat(20) })]
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

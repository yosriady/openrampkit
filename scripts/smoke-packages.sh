#!/usr/bin/env bash
# Pack every package, install the tarballs into a fresh project, and check that they work as a user
# would install them: ESM, CommonJS, React SSR, and strict TypeScript (nodenext and bundler).
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
npm install --no-audit --no-fund "$WORK"/packs/*.tgz react@19 react-dom@19 typescript@5 @types/react@19 lit viem @wagmi/core >/dev/null
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
cat > ssr.mjs <<'JS'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { OpenRampProvider, DepositButton } from '@openrampkit/react'
const html = renderToString(createElement(OpenRampProvider, { baseUrl: '/api' }, createElement(DepositButton, { getClientSecret: async () => 'x' })))
if (!html.includes('button')) throw new Error('SSR failed')
console.log('React SSR ok')
JS
node ssr.mjs
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
export { runAdapterConformance, xendit, wagmiWallet, openWithdraw }
TS
npx tsc --strict --noEmit --module nodenext --moduleResolution nodenext --target es2022 --lib es2022,dom app.ts
npx tsc --strict --noEmit --module esnext --moduleResolution bundler --target es2022 --lib es2022,dom app.ts
echo "TypeScript ok (nodenext, bundler)"

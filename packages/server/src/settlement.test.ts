// Sessions with `destination.settlement` (an OpenRampSettlement contract) and `destination.calls`.
import { describe, expect, it } from 'vitest'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { USDC } from '@openrampkit/core'
import type { Destination } from '@openrampkit/core'
import { createOpenRamp } from './index.js'

const ramp = createOpenRamp({
  secret: 'test-secret-test-secret-test-secret-123',
  baseUrl: 'http://localhost/api/openramp',
  adapters: [mockAdapter({ crypto: true })],
  logger: { debug() {}, info() {}, warn() {}, error() {} },
})

const CONTRACT = '0x2222222222222222222222222222222222222222'
const RECIPIENT = '0x000000000000000000000000000000000000beef'
const base = { type: 'crypto' as const, chain: 'eip155:421614', token: USDC['eip155:421614']!, address: RECIPIENT }
const create = (destination: Destination) => ramp.sessions.create({ userId: 'u1', destination })

describe('settlement destinations', () => {
  it('accepts a settlement contract with calls, and stores it in lower case', async () => {
    const s = await create({ ...base, settlement: { contract: CONTRACT.toUpperCase().replace('0X', '0x') }, calls: [{ to: CONTRACT, data: '0x6e553f65' }] })
    expect(s.id).toMatch(/^ors_/)
    const rec = await ramp.sessions.retrieve(s.id)
    expect(rec?.destination).toMatchObject({ settlement: { contract: CONTRACT } })
  })

  it('rejects calls without a settlement contract', async () => {
    await expect(create({ ...base, calls: [{ to: CONTRACT, data: '0x' }] })).rejects.toMatchObject({ status: 400, error: { message: expect.stringMatching(/need `destination.settlement`/) } })
  })

  it('rejects a bad settlement setup', async () => {
    const bad = (d: Partial<Extract<Destination, { type: 'crypto' }>>, re: RegExp) =>
      expect(create({ ...base, settlement: { contract: CONTRACT }, ...d })).rejects.toMatchObject({ status: 400, error: { code: 'BAD_REQUEST', message: expect.stringMatching(re) } })
    await bad({ chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }, /EVM destination chain/)
    await bad({ settlement: { contract: 'nope' } }, /contract address/)
    await bad({ address: 'not-an-address' }, /EVM `address`/)
    await bad({ token: 'native' }, /ERC-20 `token`/)
    await bad({ calls: [{ to: CONTRACT, data: '0x', value: '5' }] }, /native value/)
  })
})

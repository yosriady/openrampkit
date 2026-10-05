import { describe, expect, it } from 'vitest'
import { SPL_TOKEN_2022_PROGRAM } from '@openrampkit/core'
import { solanaPaidTo } from './solana.js'
import type { SolanaParsedTx } from './solana.js'

const OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const OWNER_ATA = 'Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP'
const OTHER = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ'
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'

const tx = (instructions: SolanaParsedTx['transaction']['message']['instructions'], over: Partial<NonNullable<SolanaParsedTx['meta']>> = {}): SolanaParsedTx => ({
  meta: { err: null, postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: OWNER, uiTokenAmount: { amount: '1' } }], ...over },
  transaction: { message: { accountKeys: [OTHER, OWNER_ATA], instructions } },
})

describe('solanaPaidTo', () => {
  it('adds transfer and transferChecked instructions into the owner token accounts of the mint', () => {
    const t = tx([
      { program: 'spl-token', parsed: { type: 'transferChecked', info: { destination: OWNER_ATA, mint: MINT, tokenAmount: { amount: '2000000' } } } },
      { programId: SPL_TOKEN_2022_PROGRAM, parsed: { type: 'transfer', info: { destination: OWNER_ATA, amount: '500000' } } },
      // Another mint, another account, another program: not counted.
      { program: 'spl-token', parsed: { type: 'transferChecked', info: { destination: OWNER_ATA, mint: OTHER, tokenAmount: { amount: '7' } } } },
      { program: 'spl-token', parsed: { type: 'transfer', info: { destination: OTHER, amount: '7' } } },
      { program: 'spl-memo', parsed: 'hello' },
    ])
    expect(solanaPaidTo(t, OWNER, MINT)).toBe(2_500_000n)
    expect(solanaPaidTo(t, OTHER, MINT)).toBe(0n)
  })

  it('is zero for a failed transaction, or without a token account of the owner', () => {
    const ix = [{ program: 'spl-token', parsed: { type: 'transfer', info: { destination: OWNER_ATA, amount: '5' } } }]
    expect(solanaPaidTo(tx(ix, { err: { InstructionError: [0, 'x'] } }), OWNER, MINT)).toBe(0n)
    expect(solanaPaidTo(tx(ix, { postTokenBalances: [] }), OWNER, MINT)).toBe(0n)
  })

  it('native: System Program transfers to the owner, in lamports', () => {
    const t = tx([
      { program: 'system', parsed: { type: 'transfer', info: { source: OTHER, destination: OWNER, lamports: 1500 } } },
      { program: 'system', parsed: { type: 'transfer', info: { source: OWNER, destination: OTHER, lamports: 99 } } },
    ])
    expect(solanaPaidTo(t, OWNER, 'native')).toBe(1500n)
  })
})

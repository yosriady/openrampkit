import { describe, expect, it } from 'vitest'
import type { TypedDataRequest } from '@openrampkit/core'
import { hashTypedData, recoverAddress, recoverTypedDataSigner } from './eip712.js'

// Vectors from viem 2 (`hashTypedData`, `signTypedData`) with the public anvil test account #1.
const SIGNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

const permit: TypedDataRequest = {
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE },
  types: {
    ReceiveWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'ReceiveWithAuthorization',
  message: {
    from: SIGNER,
    to: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be',
    value: '5000000',
    validAfter: 0,
    validBefore: 1792147801,
    nonce: '0x5455db7556e8e306ce23fa44a6e805a777e573c2ab30c40a2d51ebab2f5fd33d',
  },
}
const PERMIT_HASH = '0xc2b279cadc9dd1f6e768681fc765a48f84916c501a441ebf4709e031973fc983'
const PERMIT_SIG =
  '0x6278f304295ac5da322775502c6f9420758aa383c5a1bd480bdd41bb5213f39c4016e568a84c09e4b37dfe9689f6e9f83059dde59375be19ba50bf8525368b3e1c'

// Nested structs, struct arrays, `bytes` and `bool` (the MulticallAuthorization of an EIP-3009 permit).
const multicall: TypedDataRequest = {
  domain: { name: 'RelayApprovalProxy', version: '3.1', chainId: 8453, verifyingContract: '0x5567954cd026cebfe486062cb75848e0f1c12e58' },
  types: {
    MulticallAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'relayer', type: 'address' },
      { name: 'msgValue', type: 'uint256' },
      { name: 'refundTo', type: 'address' },
      { name: 'nftRecipient', type: 'address' },
      { name: 'metadata', type: 'bytes' },
      { name: 'fundingIndex', type: 'uint256' },
      { name: 'calls', type: 'Call3Value[]' },
      { name: 'funding', type: 'FundingAuthorization[]' },
    ],
    Call3Value: [
      { name: 'target', type: 'address' },
      { name: 'allowFailure', type: 'bool' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
    FundingAuthorization: [
      { name: 'token', type: 'address' },
      { name: 'from', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
    ],
  },
  primaryType: 'MulticallAuthorization',
  message: {
    from: SIGNER,
    relayer: '0xf70da97812cb96acdf810712aa562db8dfa3dbef',
    msgValue: '0',
    refundTo: SIGNER,
    nftRecipient: SIGNER,
    metadata: '0xabcdef',
    fundingIndex: 0,
    calls: [{ target: USDC_BASE, allowFailure: false, value: '0', callData: '0xa9059cbb0000' }],
    funding: [{ token: USDC_BASE, from: SIGNER, value: '1000000', validAfter: 0, validBefore: 1764948419 }],
  },
}
const MULTICALL_HASH = '0x90c061c931b1134d55301a740cbbdc2bf7b21dbf0ccf7fc2106a70b3e096a27a'
const MULTICALL_SIG =
  '0x34618c2aa8f3d0f87e8dc8355040d1b4898c7b12021e0c8c2d32d415c38eecab595a5742a6fb33ef665651ca38ecedce4ca4e8890cce253d47ecb8be069698b41b'

describe('EIP-712', () => {
  it('hashes typed data like viem', () => {
    expect(hashTypedData(permit)).toBe(PERMIT_HASH)
    expect(hashTypedData(multicall)).toBe(MULTICALL_HASH)
  })

  it('recovers the signer', () => {
    expect(recoverAddress(PERMIT_HASH, PERMIT_SIG)).toBe(SIGNER)
    expect(recoverTypedDataSigner(permit, PERMIT_SIG)).toBe(SIGNER)
    expect(recoverTypedDataSigner(multicall, MULTICALL_SIG)).toBe(SIGNER)
  })

  it('accepts v as 0/1 as well as 27/28', () => {
    const v01 = PERMIT_SIG.slice(0, -2) + (parseInt(PERMIT_SIG.slice(-2), 16) - 27).toString(16).padStart(2, '0')
    expect(recoverTypedDataSigner(permit, v01)).toBe(SIGNER)
  })

  it('a changed message or a signature of other data does not recover the signer', () => {
    expect(recoverTypedDataSigner({ ...permit, message: { ...permit.message, value: '5000001' } }, PERMIT_SIG)).not.toBe(SIGNER)
    expect(recoverTypedDataSigner(permit, MULTICALL_SIG)).not.toBe(SIGNER)
  })

  it('a malformed signature or data gives undefined', () => {
    expect(recoverTypedDataSigner(permit, '0x1234')).toBeUndefined()
    expect(recoverTypedDataSigner(permit, `0x${'00'.repeat(65)}`)).toBeUndefined()
    expect(recoverTypedDataSigner({ ...permit, message: { ...permit.message, from: 'nope' } }, PERMIT_SIG)).toBeUndefined()
    expect(recoverTypedDataSigner({ ...permit, primaryType: 'Missing' }, PERMIT_SIG)).toBeUndefined()
  })
})

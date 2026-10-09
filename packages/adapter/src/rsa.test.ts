import { createSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64, bytesToHex, importRsaPublicKey, randomHex, rsaKeyDer, rsaVerify } from './index.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const publicB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const publicPkcs1 = publicKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

/** base64 SHA256withRSA signature made with node:crypto, independent of WebCrypto */
const sign = (data: string | Uint8Array) => createSign('sha256').update(data).sign(privateKey).toString('base64')

describe('rsaVerify', () => {
  it('accepts a good signature with the key as PEM, base64, PEM with escaped newlines, or CryptoKey', async () => {
    const sig = sign('hello')
    expect(await rsaVerify(publicPem, 'hello', sig)).toBe(true)
    expect(await rsaVerify(publicB64, 'hello', sig)).toBe(true)
    expect(await rsaVerify(publicPem.replace(/\n/g, '\\n'), 'hello', sig)).toBe(true)
    expect(await rsaVerify(await importRsaPublicKey(publicPem), 'hello', sig)).toBe(true)
  })

  it('checks bytes as given (no extra encoding)', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    expect(await rsaVerify(publicPem, bytes, sign(bytes))).toBe(true)
    expect(await rsaVerify(publicPem, new Uint8Array([0, 1, 2, 250, 254]), sign(bytes))).toBe(false)
  })

  it('refuses a changed message, a signature from another key, and a malformed signature', async () => {
    const sig = sign('hello')
    expect(await rsaVerify(publicPem, 'hellO', sig)).toBe(false)
    const other = generateKeyPairSync('rsa', { modulusLength: 1024 })
    expect(await rsaVerify(publicPem, 'hello', createSign('sha256').update('hello').sign(other.privateKey).toString('base64'))).toBe(false)
    expect(await rsaVerify(publicPem, 'hello', '%%%not base64')).toBe(false)
    expect(await rsaVerify(publicPem, 'hello', '')).toBe(false)
    expect(await rsaVerify(publicPem, 'hello', sig.slice(0, 40))).toBe(false)
  })

  it('accepts a signature with whitespace around it', async () => {
    expect(await rsaVerify(publicPem, 'hello', ` ${sign('hello')}\n`)).toBe(true)
  })

  it('throws for a key string that is not an SPKI public key', async () => {
    await expect(rsaVerify(publicPkcs1, 'hello', sign('hello'))).rejects.toThrow(/SPKI/)
    await expect(rsaVerify(privatePem, 'hello', sign('hello'))).rejects.toThrow(/PUBLIC KEY/)
    await expect(rsaVerify('not a key', 'hello', sign('hello'))).rejects.toThrow()
  })
})

describe('rsaKeyDer', () => {
  it('reads PEM and bare base64 to the same DER', () => {
    expect(bytesToBase64(rsaKeyDer(publicPem, 'public'))).toBe(publicB64)
    expect(bytesToBase64(rsaKeyDer(publicB64, 'public'))).toBe(publicB64)
  })

  it('refuses PKCS#1 and a PEM of the other kind', () => {
    expect(() => rsaKeyDer(publicPkcs1, 'public')).toThrow(/RSA PUBLIC KEY/)
    expect(() => rsaKeyDer(publicPem, 'private')).toThrow(/PRIVATE KEY/)
  })
})

describe('byte helpers', () => {
  it('bytesToHex: lowercase, two digits per byte, from bytes or an ArrayBuffer', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 171, 255]))).toBe('00010f10abff')
    expect(bytesToHex(new Uint8Array([222, 173]).buffer)).toBe('dead')
    expect(bytesToHex(new Uint8Array())).toBe('')
    expect(randomHex(3)).toMatch(/^[0-9a-f]{6}$/)
  })

  it('base64 round trip, whitespace ignored', () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 2])
    expect(bytesToBase64(bytes)).toBe('AP+AAQI=')
    expect([...base64ToBytes('AP+A AQI=\n')]).toEqual([...bytes])
    expect(() => base64ToBytes('%%%')).toThrow()
  })
})

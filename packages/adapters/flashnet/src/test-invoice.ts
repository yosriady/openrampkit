// Tests only: build a BOLT11 invoice with a valid bech32 checksum and a fake signature.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!
  }
  return chk
}

const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)]

function intWords(n: number, len?: number): number[] {
  const out: number[] = []
  do {
    out.unshift(n % 32)
    n = Math.floor(n / 32)
  } while (n > 0)
  while (len !== undefined && out.length < len) out.unshift(0)
  return out
}

function bytesWords(hex: string): number[] {
  let acc = 0
  let bits = 0
  const out: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    acc = (acc << 8) | parseInt(hex.slice(i, i + 2), 16)
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push((acc >> bits) & 31)
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31)
  return out
}

function tag(type: number, words: number[]): number[] {
  return [type, Math.floor(words.length / 32), words.length % 32, ...words]
}

export function makeInvoice(o: { sats?: bigint; timestamp: number; expirySec?: number; hash: string; prefix?: string }): string {
  // Amount in nano-BTC: 1 sat = 10 n
  const hrp = `${o.prefix ?? 'lnbc'}${o.sats !== undefined ? `${o.sats * 10n}n` : ''}`
  const words = [
    ...intWords(o.timestamp, 7),
    ...tag(1, bytesWords(o.hash)),
    ...(o.expirySec !== undefined ? tag(6, intWords(o.expirySec)) : []),
    // description `d` (13)
    ...tag(13, bytesWords('74657374')),
    // fake 520-bit signature
    ...new Array<number>(104).fill(7),
  ]
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31)
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`
}

// A small BOLT11 reader: the network, the amount, the creation time, the expiry and the payment hash.
// It checks the bech32 checksum. It does not check the node signature: the invoice comes from Flashnet
// over TLS, and the adapter only uses these fields to refuse an invoice that does not match the order.
// Spec: https://github.com/lightning/bolts/blob/master/11-payment-encoding.md

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
/** 520 bits of signature and recovery id */
const SIGNATURE_WORDS = 104
/** Default expiry when the invoice has no `x` field (seconds) */
const DEFAULT_EXPIRY_SEC = 3600
/** msat per unit of each amount multiplier (BTC = 100_000_000_000 msat) */
const MSAT: Record<string, bigint> = { '': 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n }

export type Bolt11 = {
  /** `bc` (mainnet), `tb` (testnet or signet) or `bcrt` (regtest) */
  network: string
  /** The amount in msat, or undefined for an amountless invoice */
  amountMsat?: bigint
  /** Creation time, Unix seconds */
  timestamp: number
  /** Seconds after `timestamp` */
  expirySec: number
  /** Lowercase hex, 64 digits */
  paymentHash: string
}

function polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!
  }
  return chk
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
  return out
}

function wordsToInt(words: number[]): number {
  let n = 0
  for (const w of words) n = n * 32 + w
  return n
}

function wordsToHex(words: number[], bytes: number): string {
  let acc = 0
  let bits = 0
  const out: number[] = []
  for (const w of words) {
    acc = (acc << 5) | w
    bits += 5
    while (bits >= 8 && out.length < bytes) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
    acc &= (1 << bits) - 1
  }
  return out.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The fields of a BOLT11 invoice, or undefined when it is not a valid invoice (format or checksum). */
export function decodeBolt11(invoice: string): Bolt11 | undefined {
  if (typeof invoice !== 'string' || invoice.length < 100 || invoice.length > 2048) return undefined
  // One case only (bech32 rule)
  if (invoice !== invoice.toLowerCase() && invoice !== invoice.toUpperCase()) return undefined
  const s = invoice.toLowerCase()
  const sep = s.lastIndexOf('1')
  if (sep < 4) return undefined
  const hrp = s.slice(0, sep)
  const m = /^ln(bcrt|bc|tbs|tb)(?:(\d+)([munp]?))?$/.exec(hrp)
  if (!m) return undefined
  const data: number[] = []
  for (const c of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(c)
    if (v < 0) return undefined
    data.push(v)
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return undefined
  const words = data.slice(0, -6)
  if (words.length < 7 + SIGNATURE_WORDS) return undefined
  let amountMsat: bigint | undefined
  if (m[2] !== undefined) {
    const unit = m[3] ?? ''
    if (unit === 'p') {
      // 1 p = 0.1 msat: the amount must end in 0
      const pico = BigInt(m[2])
      if (pico % 10n !== 0n) return undefined
      amountMsat = pico / 10n
    } else amountMsat = BigInt(m[2]) * MSAT[unit]!
    if (amountMsat <= 0n) return undefined
  }
  const timestamp = wordsToInt(words.slice(0, 7))
  const tagged = words.slice(7, words.length - SIGNATURE_WORDS)
  let expirySec = DEFAULT_EXPIRY_SEC
  let paymentHash: string | undefined
  for (let i = 0; i + 3 <= tagged.length; ) {
    const type = tagged[i]!
    const len = tagged[i + 1]! * 32 + tagged[i + 2]!
    const field = tagged.slice(i + 3, i + 3 + len)
    if (field.length !== len) return undefined
    // `p` (1): payment hash, 52 words. `x` (6): expiry in seconds.
    if (type === 1 && len === 52 && paymentHash === undefined) paymentHash = wordsToHex(field, 32)
    if (type === 6) expirySec = wordsToInt(field)
    i += 3 + len
  }
  if (!paymentHash) return undefined
  const network = m[1] === 'tbs' ? 'tb' : m[1]!
  return { network, ...(amountMsat !== undefined ? { amountMsat } : {}), timestamp, expirySec, paymentHash }
}

/** When the invoice expires, in ms */
export function bolt11ExpiresAt(b: Bolt11): number {
  return (b.timestamp + b.expirySec) * 1000
}

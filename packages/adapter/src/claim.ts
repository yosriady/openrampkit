import type { ScopedKV } from './index.js'
import { bytesToHex, randomHex } from './util.js'

/**
 * Record `key` as used by `owner` (for example a transaction hash, a log, or a provider deposit that
 * may complete one payment only). Returns true when `owner` holds the key after the call, also when it
 * held the key before (so a retry gets the same answer). Returns false when another owner holds it.
 *
 * With `shared.putIfAbsent` (all built-in stores except Workers KV), the claim is atomic: when two
 * claims run at the same time, exactly one wins. Without it, this writes, then reads back to catch
 * most races.
 */
export async function claimOnce(shared: ScopedKV, key: string, owner: string, ttlSec: number): Promise<boolean> {
  if (shared.putIfAbsent) {
    if (await shared.putIfAbsent(key, owner, ttlSec)) return true
    return (await shared.get<string>(key)) === owner
  }
  const cur = await shared.get<string>(key)
  if (cur) return cur === owner
  await shared.put(key, owner, ttlSec)
  return (await shared.get<string>(key)) === owner
}

/** How long the server remembers a provider webhook delivery for replay protection: 7 days */
export const WEBHOOK_REPLAY_TTL_SEC = 7 * 24 * 60 * 60

/** The value of a replay key whose delivery could not be applied: the next delivery may take it. */
const RELEASED = 'released'

const replayKeyOf = (key: string) => `webhook:${key}`

/**
 * Claim one provider webhook delivery by its replay key (see `Adapter.webhook.replayKey`). Returns a
 * claim token when this delivery is the first, or `undefined` when the key was seen in the last
 * `ttlSec` seconds (a replay or a duplicate). Built on `claimOnce`, so it is atomic on stores with
 * `putIfAbsent`. The server calls it; adapters only give the key.
 */
export async function claimWebhook(shared: ScopedKV, key: string, ttlSec = WEBHOOK_REPLAY_TTL_SEC): Promise<string | undefined> {
  const k = replayKeyOf(key)
  const token = randomHex(12)
  if (await claimOnce(shared, k, token, ttlSec)) return token
  // A delivery that could not be applied gave the key back: take it over.
  if ((await shared.get<string>(k)) !== RELEASED) return undefined
  await shared.put(k, token, ttlSec)
  return (await shared.get<string>(k)) === token ? token : undefined
}

/**
 * Give a webhook claim back, because its events could not be applied yet (the provider sends the
 * webhook again). Only the holder of `token` can release it.
 */
export async function releaseWebhook(shared: ScopedKV, key: string, token: string, ttlSec = WEBHOOK_REPLAY_TTL_SEC): Promise<void> {
  const k = replayKeyOf(key)
  if ((await shared.get<string>(k)) === token) await shared.put(k, RELEASED, ttlSec)
}

/**
 * A replay key from the raw webhook body: its SHA-256, hex. For providers that sign the body with no
 * timestamp or event id, so the same signed body could be sent again later.
 */
export async function webhookBodyKey(rawBody: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody)))
}

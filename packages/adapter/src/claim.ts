import type { ScopedKV } from './index.js'

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

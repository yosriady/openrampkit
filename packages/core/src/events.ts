import { API_VERSION } from './types.js'
import type { ClientEventFields, ClientEventOf, ClientEventType, WebhookEventOf, WebhookEventType } from './types.js'

export function randomId(prefix: string, bytes = 12): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return `${prefix}_${s}`
}

/** Build a browser UI event. The id is random. */
export function createClientEvent<T extends ClientEventType>(type: T, object: ClientEventFields[T], opts: { sessionId?: string; livemode?: boolean } = {}): ClientEventOf<T> {
  return {
    id: randomId('evt'),
    type,
    createdAt: new Date().toISOString(),
    livemode: opts.livemode ?? false,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    data: { object },
  }
}

/** Build a webhook event envelope. The server gives a deterministic `id`. */
export function createWebhookEvent<T extends WebhookEventType>(
  type: T,
  object: WebhookEventOf<T>['data']['object'],
  opts: { id: string; sessionId: string; livemode: boolean; createdAt?: string },
): WebhookEventOf<T> {
  return {
    id: opts.id,
    object: 'event',
    apiVersion: API_VERSION,
    type,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    livemode: opts.livemode,
    sessionId: opts.sessionId,
    data: { object },
  }
}

// The session timeline: a short, capped list of what happened to a session, for operators.
// It lives in the session record and is saved with the change that made it.

import type { SessionRecord } from './store.js'

/** Most timeline entries kept per session. The oldest one goes first. */
export const MAX_TIMELINE = 100

export function addTimeline(rec: SessionRecord, type: string, detail?: Record<string, unknown>): void {
  const next = [...(rec.timeline ?? []), { at: Date.now(), type, ...(detail && Object.keys(detail).length ? { detail } : {}) }]
  rec.timeline = next.length > MAX_TIMELINE ? next.slice(-MAX_TIMELINE) : next
}

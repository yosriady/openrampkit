// URL checks for surfaces. Provider URLs reach the browser as links, popups and iframes, so a
// `javascript:` or `data:` URL must never get through.

/** Schemes that run code or read local data when the browser opens them. */
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'blob:', 'file:', 'about:', 'filesystem:'])

/** True for an absolute `https:` URL, or `http:` when `allowHttp` is true. */
export function isWebUrl(url: unknown, opts: { allowHttp?: boolean } = {}): url is string {
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (!!opts.allowHttp && u.protocol === 'http:')
  } catch {
    return false
  }
}

/**
 * True for a URL that is safe to open as an app link: a web URL (`http:` or `https:`) or an app
 * scheme such as `gcash://pay`. Refuses `javascript:`, `data:`, `vbscript:`, `blob:`, `file:` and `about:`.
 */
export function isSafeLinkUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    return !BLOCKED_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

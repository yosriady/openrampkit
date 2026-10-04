import { svg } from 'lit'
import type { SVGTemplateResult } from 'lit'

const icon = (body: SVGTemplateResult) =>
  svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`

export const icons = {
  close: icon(svg`<path d="M6 6l12 12M18 6L6 18"/>`),
  back: icon(svg`<path d="M15 5l-7 7 7 7"/>`),
  chevron: icon(svg`<path d="M9 5l7 7-7 7"/>`),
  check: icon(svg`<path d="M5 12.5l4.5 4.5L19 7.5"/>`),
  alert: icon(svg`<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>`),
  x: icon(svg`<path d="M7 7l10 10M17 7L7 17"/>`),
  card: icon(svg`<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h3"/>`),
  bank: icon(svg`<path d="M3 9.5L12 4l9 5.5M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3.5 20h17"/>`),
  qr: icon(svg`<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>`),
  ewallet: icon(svg`<rect x="6.5" y="3" width="11" height="18" rx="2.5"/><path d="M11 17.5h2"/>`),
  wallet: icon(svg`<path d="M4 7.5A2.5 2.5 0 016.5 5H18v3"/><rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M16 13.5h.01"/>`),
  transfer: icon(svg`<path d="M7 7h11l-3-3M17 17H6l3 3"/>`),
  exchange: icon(svg`<path d="M4 20V10l8-6 8 6v10"/><path d="M9 20v-6h6v6"/>`),
  external: icon(svg`<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>`),
  pay: icon(svg`<path d="M12 3v18M16.5 7H10a3 3 0 000 6h4a3 3 0 010 6H7"/>`),
}

export function methodIcon(kind: string, method: string) {
  if (method === 'transfer') return icons.transfer
  if (method === 'exchange_transfer') return icons.exchange
  switch (kind) {
    case 'card':
      return icons.card
    case 'bank':
      return icons.bank
    case 'qr':
      return icons.qr
    case 'ewallet':
      return icons.ewallet
    case 'crypto':
      return icons.wallet
    case 'exchange':
      return icons.exchange
    default:
      return icons.pay
  }
}

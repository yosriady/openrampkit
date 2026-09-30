// Message catalogs and locale resolution for the modal.
// English (`i18n/en.ts`) defines every key. Each translation is typed `Messages`, so TypeScript
// rejects a catalog that misses a key. Keep copy short and plain. Do not use em dashes or en dashes.

import { en } from './i18n/en.js'
import type { Messages } from './i18n/en.js'
import { fil } from './i18n/fil.js'
import { id } from './i18n/id.js'
import { ms } from './i18n/ms.js'
import { th } from './i18n/th.js'
import { vi } from './i18n/vi.js'

export { en, vi, id, th, ms, fil }
export type { Messages }

/** Built-in catalogs by language subtag. */
export const catalogs = { en, vi, id, th, ms, fil } satisfies Record<string, Messages>

export type CatalogLocale = keyof typeof catalogs

/** Older or alternative language codes that map to a built-in catalog. */
const ALIASES: Record<string, CatalogLocale> = { tl: 'fil', in: 'id', zsm: 'ms' }

/** The built-in catalog for a BCP 47 tag, matched on the language subtag ("vi-VN" -> vi). */
export function catalogFor(tag: string | undefined): CatalogLocale | undefined {
  if (!tag) return undefined
  const lang = tag.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  if (lang in catalogs) return lang as CatalogLocale
  return ALIASES[lang]
}

export type LocaleSources = {
  /** Explicit `locale` option of the element, `openDeposit()` or the React provider */
  locale?: string | undefined
  /** `PublicSession.locale` from the server */
  sessionLocale?: string | undefined
}

/**
 * Pick the catalog and the formatting tag.
 * Order: explicit locale > session locale > English. The browser language is not used,
 * so the modal is in English unless the app asks for another language.
 *
 * - An explicit locale always sets the formatting tag, even without a built-in catalog
 *   (for example `fr` together with French `messages` overrides). Its strings fall back to English.
 * - A session locale counts only when a built-in catalog matches it.
 * - The server sends a session locale only when the app set one, so a session `en` is a real choice.
 */
export function resolveLocale(src: LocaleSources = {}): { catalog: CatalogLocale; tag: string } {
  if (src.locale) return { catalog: catalogFor(src.locale) ?? 'en', tag: src.locale }
  const catalog = catalogFor(src.sessionLocale)
  if (catalog) return { catalog, tag: src.sessionLocale! }
  return { catalog: 'en', tag: 'en' }
}

/**
 * The messages to render: explicit `overrides` > the resolved locale catalog > English.
 * `locale` in the result is the tag used for number and currency formatting.
 */
export function resolveMessages(src: LocaleSources & { messages?: Partial<Messages> | undefined } = {}): Messages {
  const { catalog, tag } = resolveLocale(src)
  return { ...catalogs[catalog], locale: tag, ...src.messages }
}

/** Merge a partial override (for example a translation) over the English catalog. */
export function mergeMessages(overrides?: Partial<Messages>): Messages {
  return overrides ? { ...en, ...overrides } : en
}

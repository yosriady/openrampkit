// Theme tokens. No Lit import here, so frameworks can import themes on the server
// through `@openrampkit/web/theme`.

export type ThemeColors = {
  accent: string
  accentText: string
  accentSoft: string
  background: string
  surface: string
  surfaceHover: string
  border: string
  text: string
  textSecondary: string
  textMuted: string
  success: string
  successSoft: string
  danger: string
  dangerSoft: string
  warning: string
  warningSoft: string
  overlay: string
  focus: string
  shadow: string
}

export type RadiusScale = 'none' | 'small' | 'medium' | 'large'

export type ThemeMode = 'light' | 'dark' | 'auto'

export type Theme = {
  mode: ThemeMode
  accent?: string
  accentText?: string
  radius?: RadiusScale
  fontFamily?: string
  /** Color overrides. With mode `auto` they apply to both light and dark. */
  colors?: Partial<ThemeColors>
}

export type ThemeOptions = {
  accent?: string
  accentText?: string
  radius?: RadiusScale
  fontFamily?: string
  colors?: Partial<ThemeColors>
}

/** Fine control, like D0's appearance object. Applied on top of the theme. */
export type Appearance = {
  colors?: { light?: Partial<ThemeColors>; dark?: Partial<ThemeColors> }
  radius?: Partial<{ card: string; row: string; button: string; input: string }>
  fontFamily?: string
  fontFamilyMono?: string
  borderWidth?: string
  /** Header title on the first screen. Default: "Deposit" */
  title?: string
  merchantName?: string
  logoUrl?: string
  /** Hide the "Powered by" footer */
  hideFooter?: boolean
}

export const lightColors: ThemeColors = {
  accent: '#2744C4',
  accentText: '#FFFFFF',
  accentSoft: 'rgba(39, 68, 196, 0.10)',
  background: '#FFFFFF',
  surface: '#F5F6F8',
  surfaceHover: '#ECEEF2',
  border: 'rgba(15, 23, 42, 0.10)',
  text: '#0F172A',
  textSecondary: '#475467',
  textMuted: '#5F6B7F',
  success: '#0A6A4B',
  successSoft: 'rgba(10, 106, 75, 0.12)',
  danger: '#C8322B',
  dangerSoft: 'rgba(200, 50, 43, 0.10)',
  warning: '#9A5B00',
  warningSoft: 'rgba(214, 138, 0, 0.14)',
  overlay: 'rgba(15, 23, 42, 0.45)',
  focus: '#2744C4',
  shadow: '0 24px 64px rgba(15, 23, 42, 0.18), 0 2px 8px rgba(15, 23, 42, 0.06)',
}

export const darkColors: ThemeColors = {
  accent: '#6E8BFF',
  accentText: '#0B0D12',
  accentSoft: 'rgba(110, 139, 255, 0.16)',
  background: '#16181D',
  surface: '#1F2229',
  surfaceHover: '#272B33',
  border: 'rgba(255, 255, 255, 0.09)',
  text: '#F2F4F7',
  textSecondary: '#B4BBC7',
  textMuted: '#8B93A2',
  success: '#3DD68C',
  successSoft: 'rgba(61, 214, 140, 0.14)',
  danger: '#FF6B61',
  dangerSoft: 'rgba(255, 107, 97, 0.14)',
  warning: '#F5B544',
  warningSoft: 'rgba(245, 181, 68, 0.14)',
  overlay: 'rgba(0, 0, 0, 0.62)',
  focus: '#8FA6FF',
  shadow: '0 24px 64px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.3)',
}

export const RADII: Record<RadiusScale, { card: string; row: string; button: string; input: string }> = {
  none: { card: '0px', row: '0px', button: '0px', input: '0px' },
  small: { card: '12px', row: '8px', button: '8px', input: '8px' },
  medium: { card: '16px', row: '12px', button: '12px', input: '12px' },
  large: { card: '20px', row: '14px', button: '14px', input: '14px' },
}

export const DEFAULT_FONT =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
export const DEFAULT_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"

function make(mode: ThemeMode, opts: ThemeOptions = {}): Theme {
  return {
    mode,
    ...(opts.accent ? { accent: opts.accent } : {}),
    ...(opts.accentText ? { accentText: opts.accentText } : {}),
    radius: opts.radius ?? 'large',
    ...(opts.fontFamily ? { fontFamily: opts.fontFamily } : {}),
    ...(opts.colors ? { colors: opts.colors } : {}),
  }
}

export function lightTheme(opts?: ThemeOptions): Theme {
  return make('light', opts)
}

export function darkTheme(opts?: ThemeOptions): Theme {
  return make('dark', opts)
}

/** Follows the user's system setting (prefers-color-scheme). */
export function autoTheme(opts?: ThemeOptions): Theme {
  return make('auto', opts)
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/**
 * Resolve a theme and an appearance into CSS custom properties (`--ork-*`) for one concrete mode.
 * The element sets them as inline styles on the host.
 */
export function themeVariables(theme: Theme | undefined, appearance: Appearance | undefined, mode: 'light' | 'dark'): Record<string, string> {
  const base = mode === 'dark' ? darkColors : lightColors
  const colors: ThemeColors = {
    ...base,
    ...(theme?.accent
      ? {
          accent: theme.accent,
          // The focus ring needs 3:1 against the card (WCAG 1.4.11). Keep the default ring when the accent is too faint.
          focus: (contrastRatio(theme.accent, base.background) ?? 3) >= 3 ? theme.accent : base.focus,
          accentSoft: soft(theme.accent, mode === 'dark' ? 0.16 : 0.1),
          accentText: readableText(theme.accent) ?? base.accentText,
        }
      : {}),
    ...(theme?.accentText ? { accentText: theme.accentText } : {}),
    ...theme?.colors,
    ...appearance?.colors?.[mode],
  }
  const radius = { ...RADII[theme?.radius ?? 'large'], ...appearance?.radius }
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(colors)) vars[`--ork-color-${kebab(k)}`] = v
  vars['--ork-shadow-card'] = colors.shadow
  vars['--ork-radius-card'] = radius.card
  vars['--ork-radius-row'] = radius.row
  vars['--ork-radius-button'] = radius.button
  vars['--ork-radius-input'] = radius.input
  vars['--ork-font-family'] = appearance?.fontFamily ?? theme?.fontFamily ?? DEFAULT_FONT
  vars['--ork-font-mono'] = appearance?.fontFamilyMono ?? DEFAULT_MONO
  vars['--ork-border-width'] = appearance?.borderWidth ?? '1px'
  return vars
}

/** Transparent version of a hex color, for soft backgrounds. Returns the input when it is not hex. */
function soft(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return color
  let hex = m[1]!
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  const n = parseInt(hex, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** Relative luminance (WCAG) of a hex color. Undefined when the color is not hex. */
function luminance(color: string): number | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return undefined
  let hex = m[1]!
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  const n = parseInt(hex, 16)
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}

/** WCAG contrast ratio of two hex colors. Undefined when one of them is not hex. */
export function contrastRatio(a: string, b: string): number | undefined {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === undefined || lb === undefined) return undefined
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Black or white text for a hex background, by relative luminance. Undefined when the color is not hex. */
function readableText(color: string): string | undefined {
  const l = luminance(color)
  if (l === undefined) return undefined
  return l > 0.4 ? '#0B0D12' : '#FFFFFF'
}

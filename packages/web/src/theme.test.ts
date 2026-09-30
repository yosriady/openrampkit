import { describe, expect, it } from 'vitest'
import { DEFAULT_FONT, DEFAULT_MONO, RADII, autoTheme, contrastRatio, darkColors, darkTheme, lightColors, lightTheme, themeVariables } from './theme.js'

describe('theme factories', () => {
  it('build themes with the large radius by default', () => {
    expect(lightTheme()).toEqual({ mode: 'light', radius: 'large' })
    expect(darkTheme({ radius: 'none' })).toEqual({ mode: 'dark', radius: 'none' })
    expect(autoTheme({ accent: '#f00', accentText: '#000', fontFamily: 'Inter', colors: { text: 'red' } })).toEqual({
      mode: 'auto',
      accent: '#f00',
      accentText: '#000',
      radius: 'large',
      fontFamily: 'Inter',
      colors: { text: 'red' },
    })
  })
})

describe('themeVariables', () => {
  it('defaults: light colors, large radius, default fonts', () => {
    const v = themeVariables(undefined, undefined, 'light')
    expect(v['--ork-color-accent']).toBe(lightColors.accent)
    expect(v['--ork-color-accent-text']).toBe(lightColors.accentText)
    expect(v['--ork-color-surface-hover']).toBe(lightColors.surfaceHover)
    expect(v['--ork-shadow-card']).toBe(lightColors.shadow)
    expect(v['--ork-radius-card']).toBe(RADII.large.card)
    expect(v['--ork-radius-input']).toBe(RADII.large.input)
    expect(v['--ork-font-family']).toBe(DEFAULT_FONT)
    expect(v['--ork-font-mono']).toBe(DEFAULT_MONO)
    expect(v['--ork-border-width']).toBe('1px')
    // one variable per color, plus shadow, 4 radii, 2 fonts and border width
    expect(Object.keys(v)).toHaveLength(Object.keys(lightColors).length + 8)
  })

  it('dark mode uses the dark palette', () => {
    const v = themeVariables(darkTheme(), undefined, 'dark')
    expect(v['--ork-color-background']).toBe(darkColors.background)
    expect(v['--ork-color-text']).toBe(darkColors.text)
  })

  it('auto theme resolves by the mode argument', () => {
    const t = autoTheme()
    expect(themeVariables(t, undefined, 'dark')['--ork-color-background']).toBe(darkColors.background)
    expect(themeVariables(t, undefined, 'light')['--ork-color-background']).toBe(lightColors.background)
  })

  it('accent sets focus when it has 3:1 contrast with the card, else keeps the default ring', () => {
    expect(themeVariables(lightTheme({ accent: '#12805C' }), undefined, 'light')['--ork-color-focus']).toBe('#12805C')
    // Yellow on white is too faint for a focus ring
    expect(themeVariables(lightTheme({ accent: '#ffcc00' }), undefined, 'light')['--ork-color-focus']).toBe(lightColors.focus)
    // Dark blue on the dark card is too faint as well
    expect(themeVariables(darkTheme({ accent: '#2744C4' }), undefined, 'dark')['--ork-color-focus']).toBe(darkColors.focus)
    expect(themeVariables(darkTheme({ accent: '#ffcc00' }), undefined, 'dark')['--ork-color-focus']).toBe('#ffcc00')
    // A non-hex accent cannot be measured, so it is used as is
    expect(themeVariables(lightTheme({ accent: 'rebeccapurple' }), undefined, 'light')['--ork-color-focus']).toBe('rebeccapurple')
  })

  it('default palettes meet WCAG AA contrast for text', () => {
    for (const c of [lightColors, darkColors]) {
      for (const bg of [c.background, c.surface, c.surfaceHover]) {
        expect(contrastRatio(c.text, bg)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(c.textSecondary, bg)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(c.textMuted, bg)).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrastRatio(c.accentText, c.accent)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(c.focus, c.background)).toBeGreaterThanOrEqual(3)
    }
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21)
    expect(contrastRatio('red', '#000')).toBeUndefined()
  })

  it('accent sets a soft tint and readable text', () => {
    const light = themeVariables(lightTheme({ accent: '#ffcc00' }), undefined, 'light')
    expect(light['--ork-color-accent']).toBe('#ffcc00')
    expect(light['--ork-color-accent-soft']).toBe('rgba(255, 204, 0, 0.1)')
    expect(light['--ork-color-accent-text']).toBe('#0B0D12') // yellow is light: dark text
    const dark = themeVariables(darkTheme({ accent: '#123' }), undefined, 'dark')
    expect(dark['--ork-color-accent-soft']).toBe('rgba(17, 34, 51, 0.16)')
    expect(dark['--ork-color-accent-text']).toBe('#FFFFFF')
  })

  it('a non-hex accent keeps the base accent text and uses the color as the soft tint', () => {
    const v = themeVariables(lightTheme({ accent: 'rebeccapurple' }), undefined, 'light')
    expect(v['--ork-color-accent-soft']).toBe('rebeccapurple')
    expect(v['--ork-color-accent-text']).toBe(lightColors.accentText)
  })

  it('explicit accentText and colors win over the derived values', () => {
    const v = themeVariables(lightTheme({ accent: '#ffcc00', accentText: '#123456', colors: { text: '#111111', accentSoft: 'pink' } }), undefined, 'light')
    expect(v['--ork-color-accent-text']).toBe('#123456')
    expect(v['--ork-color-text']).toBe('#111111')
    expect(v['--ork-color-accent-soft']).toBe('pink')
  })

  it('appearance overrides colors per mode, radius, fonts and border width', () => {
    const appearance = {
      colors: { light: { text: 'black' }, dark: { text: 'white' } },
      radius: { card: '3px', button: '99px' },
      fontFamily: 'Inter',
      fontFamilyMono: 'Mono',
      borderWidth: '2px',
    }
    const theme = lightTheme({ radius: 'small', fontFamily: 'Theme font', colors: { text: 'grey' } })
    const l = themeVariables(theme, appearance, 'light')
    const d = themeVariables(theme, appearance, 'dark')
    expect(l['--ork-color-text']).toBe('black')
    expect(d['--ork-color-text']).toBe('white')
    expect(l['--ork-radius-card']).toBe('3px')
    expect(l['--ork-radius-button']).toBe('99px')
    expect(l['--ork-radius-row']).toBe(RADII.small.row)
    expect(l['--ork-font-family']).toBe('Inter')
    expect(l['--ork-font-mono']).toBe('Mono')
    expect(l['--ork-border-width']).toBe('2px')
    expect(themeVariables(theme, undefined, 'light')['--ork-font-family']).toBe('Theme font')
  })
})

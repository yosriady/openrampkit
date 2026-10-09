// @openrampkit/vue: thin Vue 3 wrapper over the <openramp-modal> web component.
// SSR-safe (Nuxt): `@openrampkit/web` (Lit) is only loaded in the browser, in onMounted and click handlers.

export { OpenRampProvider, provideOpenRamp, useOpenRamp } from './provider.js'
export type { OpenRampProviderProps, OpenRampApi } from './provider.js'
export type { OpenRampConfig, BeginDepositOptions, BeginWithdrawOptions } from './ramp.js'
export { DepositButton, DepositButtonCustom, WithdrawButton, WithdrawButtonCustom } from './button.js'
export type {
  ButtonComponent,
  DepositButtonProps,
  DepositButtonCustomProps,
  DepositButtonSlotProps,
  WithdrawButtonProps,
  WithdrawButtonCustomProps,
  WithdrawButtonSlotProps,
} from './button.js'
export { OpenRampEmbedded } from './embedded.js'
export type { OpenRampEmbeddedProps } from './embedded.js'
export { useDepositController } from './headless.js'
export { lightTheme, darkTheme, autoTheme } from '@openrampkit/web/theme'
export type { Theme, ThemeOptions, ThemeColors, Appearance, RadiusScale } from '@openrampkit/web/theme'
export type { DepositController, WithdrawController, RampController, Snapshot } from '@openrampkit/client'
export type { PublicSession, OpenRampError, OpenRampEvent, WalletAdapter } from '@openrampkit/core'

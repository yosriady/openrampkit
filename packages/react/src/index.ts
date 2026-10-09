// @openrampkit/react: thin React wrapper over the <openramp-modal> web component.
// SSR-safe: `@openrampkit/web` (Lit) is only loaded in the browser, inside effects and handlers.

export { OpenRampProvider, useOpenRamp } from './provider.js'
export type { OpenRampProviderProps, BeginDepositOptions, BeginWithdrawOptions, OpenRampApi } from './provider.js'
export { DepositButton, WithdrawButton } from './button.js'
export type {
  DepositButtonProps,
  DepositButtonCustomProps,
  DepositButtonRenderProps,
  WithdrawButtonProps,
  WithdrawButtonCustomProps,
  WithdrawButtonRenderProps,
} from './button.js'
export { OpenRampEmbedded } from './embedded.js'
export type { OpenRampEmbeddedProps } from './embedded.js'
export { useDepositController } from './headless.js'
export { lightTheme, darkTheme, autoTheme } from '@openrampkit/web/theme'
export type { Theme, ThemeOptions, ThemeColors, Appearance, RadiusScale } from '@openrampkit/web/theme'
export type { DepositController, WithdrawController, RampController, Snapshot } from '@openrampkit/client'
export type { PublicSession, OpenRampError, ClientEvent, WalletAdapter } from '@openrampkit/core'

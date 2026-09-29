// @openrampkit/react: thin React wrapper over the <openramp-modal> web component.
// SSR-safe: `@openrampkit/web` (Lit) is only loaded in the browser, inside effects and handlers.

export { OpenRampProvider, useOpenRamp } from './provider.js'
export type { OpenRampProviderProps, BeginDepositOptions, OpenRampApi } from './provider.js'
export { DepositButton } from './button.js'
export type { DepositButtonProps, DepositButtonCustomProps, DepositButtonRenderProps } from './button.js'
export { OpenRampEmbedded } from './embedded.js'
export type { OpenRampEmbeddedProps } from './embedded.js'
export { useDepositController } from './headless.js'
export { lightTheme, darkTheme, autoTheme } from '@openrampkit/web/theme'
export type { Theme, ThemeOptions, ThemeColors, Appearance, RadiusScale } from '@openrampkit/web/theme'
export type { DepositController, Snapshot } from '@openrampkit/client'
export type { PublicSession, OrkError, OrkEvent, WalletAdapter } from '@openrampkit/core'

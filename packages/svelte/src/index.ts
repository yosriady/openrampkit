// @openrampkit/svelte: thin Svelte wrapper over the <openramp-modal> web component.
// Plain TypeScript (stores, actions, context helpers), so it needs no Svelte compiler and works with Svelte 4 and 5.
// SSR-safe (SvelteKit): `@openrampkit/web` (Lit) is only loaded in the browser, in actions and click handlers.

export { createOpenRamp, depositControllerStore } from './openramp.js'
export type { OpenRamp } from './openramp.js'
export type { OpenRampConfig, BeginDepositOptions, BeginWithdrawOptions } from './ramp.js'
export { setOpenRamp, getOpenRamp } from './context.js'
export { depositButton, withdrawButton, openRampEmbedded } from './actions.js'
export type { ActionReturn, ButtonActionParams, EmbeddedActionParams } from './actions.js'
export type { Readable } from './store.js'
export { lightTheme, darkTheme, autoTheme } from '@openrampkit/web/theme'
export type { Theme, ThemeOptions, ThemeColors, Appearance, RadiusScale } from '@openrampkit/web/theme'
export type { DepositController, WithdrawController, RampController, Snapshot } from '@openrampkit/client'
export type { PublicSession, OpenRampError, ClientEvent, WalletAdapter } from '@openrampkit/core'

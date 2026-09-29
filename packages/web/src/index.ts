// @openrampkit/web: the <openramp-modal> web component (Lit, Shadow DOM) and `openDeposit()`.

import { defineOpenRampModal } from './element.js'

export { OpenRampModal, defineOpenRampModal, TAG_NAME } from './element.js'
export {
  openDeposit,
  createDepositController,
  resolveClientSecret,
  SUPPORTED_SURFACES,
  CLOSED_CODE,
} from './open.js'
export type { OpenDepositOptions, DepositHandle, CreateControllerOptions, ClientSecretSource } from './open.js'
export * from './theme.js'
export { en as defaultMessages, mergeMessages, resolveMessages, resolveLocale, catalogFor, catalogs } from './messages.js'
export type { Messages, CatalogLocale, LocaleSources } from './messages.js'
export { classifyIframeMessage, iframeOrigin, EMBED_SOURCE } from './view.js'
export type { IframeSignal } from './view.js'
export { DepositController } from '@openrampkit/client'
export type { Snapshot, ScreenName, SurfaceSignal, Tab } from '@openrampkit/client'
export type { IframeMessages, MethodOption, PlanResult, PublicSession, Quote, Step, Surface, OrkError, OrkEvent, WalletAdapter } from '@openrampkit/core'

// Register the element when this module loads in a browser (no-op on the server).
defineOpenRampModal()

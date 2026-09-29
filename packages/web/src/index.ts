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
export { en as defaultMessages, mergeMessages } from './messages.js'
export type { Messages } from './messages.js'
export { DepositController } from '@openrampkit/client'
export type { Snapshot, ScreenName, Tab } from '@openrampkit/client'
export type { MethodOption, PlanResult, PublicSession, Quote, Step, Surface, OrkError, OrkEvent, WalletAdapter } from '@openrampkit/core'

// Register the element when this module loads in a browser (no-op on the server).
defineOpenRampModal()

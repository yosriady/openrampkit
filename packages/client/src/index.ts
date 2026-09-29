// Framework-free client. `createOpenRampClient` talks to the app's OpenRampKit server.
// `DepositController` holds the modal state; UIs render `getSnapshot()` and call its actions.

export { createOpenRampClient, OrkClientError, toOrkError } from './client.js'
export type { ClientOptions, OpenRampClient } from './client.js'
export { RampController, RampController as DepositController, RampController as WithdrawController, isValidTargetAddress, withdrawTokens } from './controller.js'
export type { ControllerOptions, ScreenName, Snapshot, SurfaceSignal, Tab, TargetDraft } from './controller.js'
export type { MethodOption, PlanResult, PublicSession, Quote, Step, WalletAdapter, WalletBalance } from '@openrampkit/core'
export { createMockWallet } from './mock-wallet.js'

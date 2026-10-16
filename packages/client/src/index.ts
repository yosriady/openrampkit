// Framework-free client. `createOpenRampClient` talks to the app's OpenRampKit server.
// `DepositController` holds the modal state; UIs render `getSnapshot()` and call its actions.

export { createOpenRampClient, OpenRampClientError, toOpenRampError } from './client.js'
export type { ClientOptions, DepositAddressView, OpenRampClient } from './client.js'
export { RampController, RampController as DepositController, RampController as WithdrawController, DEPOSIT_ADDRESS_METHOD, isValidTargetAddress, withdrawTokens } from './controller.js'
export type { ControllerOptions, FlowOptions, ScreenName, Snapshot, SurfaceSignal, Tab, TargetDraft } from './controller.js'
export type { HistoryItem, MethodOption, PlanResult, PublicLegQuote, PublicQuote, PublicSession, Step, WalletAdapter, WalletBalance } from '@openrampkit/core'
export { createMockWallet } from './mock-wallet.js'

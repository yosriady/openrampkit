import type { OpenRampError, OpenRampErrorCode } from './types.js'

const DEFAULT_MESSAGES: Partial<Record<OpenRampErrorCode, string>> = {
  REGION_UNSUPPORTED: 'This method is not available in your region.',
  AMOUNT_TOO_LOW: 'The amount is below the minimum for this method.',
  AMOUNT_TOO_HIGH: 'The amount is above the maximum for this method.',
  QUOTE_EXPIRED: 'The quote expired. Get a new quote to continue.',
  NO_QUOTES: 'No provider can serve this amount right now. Try another method or amount.',
  PROVIDER_DECLINED: 'The provider declined this payment. Try another method.',
  KYC_REJECTED: 'The provider could not verify your identity.',
  PAYMENT_FAILED: 'The payment did not go through. You can try again.',
  PAYMENT_REVERSED: 'The provider refunded or reversed this payment after it completed.',
  DELIVERY_FAILED: 'The funds could not be delivered. Contact support.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  PROVIDER_UNAVAILABLE: 'The provider is not available right now.',
  CLIENT_UPGRADE_REQUIRED: 'Update the app to use this method.',
  SESSION_EXPIRED: 'This session expired. Start a new deposit.',
  UNAUTHORIZED: 'This session is not valid.',
  CONFLICT: 'The session changed at the same time. Try again.',
  ADDRESS_REJECTED: 'This address cannot receive withdrawals. Use another address.',
  DESTINATION_NOT_ALLOWED: 'This app does not allow withdrawals to this target.',
  DESTINATION_LOCKED: 'The app set where these funds go. You cannot change it.',
  BAD_REQUEST: 'The request is not valid.',
  NOT_FOUND: 'Not found.',
  INTERNAL: 'Something went wrong on our side.',
  PROVIDER_ERROR: 'The provider could not complete this request. Try again or choose another method.',
  CANCELED: 'This session was canceled.',
  IDEMPOTENCY_MISMATCH: 'This Idempotency-Key was used with another request.',
  EXTERNAL_ID_CONFLICT: 'This externalId is already used. Use a new externalId.',
  CLOSED: 'The window was closed before the payment finished.',
}

const RETRYABLE: Partial<Record<OpenRampErrorCode, boolean>> = {
  CONFLICT: true,
  QUOTE_EXPIRED: true,
  NO_QUOTES: true,
  PAYMENT_FAILED: true,
  RATE_LIMITED: true,
  PROVIDER_UNAVAILABLE: true,
  INTERNAL: true,
}

export function openRampError(code: OpenRampErrorCode, overrides: Partial<Omit<OpenRampError, 'code'>> = {}): OpenRampError {
  return {
    code,
    message: overrides.message ?? DEFAULT_MESSAGES[code] ?? 'Something went wrong.',
    retryable: overrides.retryable ?? RETRYABLE[code] ?? false,
    ...(overrides.recovery ? { recovery: overrides.recovery } : {}),
    ...(overrides.legId ? { legId: overrides.legId } : {}),
  }
}

/** Error class for throwing across boundaries; serializes to OpenRampError. */
export class OpenRampException extends Error {
  readonly error: OpenRampError
  readonly status: number
  constructor(error: OpenRampError, status = 400) {
    super(error.message)
    this.error = error
    this.status = status
  }
}

export function isOpenRampError(value: unknown): value is OpenRampError {
  return !!value && typeof value === 'object' && 'code' in value && 'message' in value
}

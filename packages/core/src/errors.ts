import type { OrkError, OrkErrorCode } from './types.js'

const DEFAULT_MESSAGES: Partial<Record<OrkErrorCode, string>> = {
  REGION_UNSUPPORTED: 'This method is not available in your region.',
  AMOUNT_TOO_LOW: 'The amount is below the minimum for this method.',
  AMOUNT_TOO_HIGH: 'The amount is above the maximum for this method.',
  QUOTE_EXPIRED: 'The quote expired. Get a new quote to continue.',
  NO_QUOTES: 'No provider can serve this amount right now. Try another method or amount.',
  PROVIDER_DECLINED: 'The provider declined this payment. Try another method.',
  KYC_REJECTED: 'The provider could not verify your identity.',
  PAYMENT_FAILED: 'The payment did not go through. You can try again.',
  DELIVERY_FAILED: 'The funds could not be delivered. Contact support.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  PROVIDER_UNAVAILABLE: 'The provider is not available right now.',
  CLIENT_UPGRADE_REQUIRED: 'Update the app to use this method.',
  SESSION_EXPIRED: 'This session expired. Start a new deposit.',
  UNAUTHORIZED: 'This session is not valid.',
  BAD_REQUEST: 'The request is not valid.',
  NOT_FOUND: 'Not found.',
  INTERNAL: 'Something went wrong on our side.',
}

const RETRYABLE: Partial<Record<OrkErrorCode, boolean>> = {
  QUOTE_EXPIRED: true,
  NO_QUOTES: true,
  PAYMENT_FAILED: true,
  RATE_LIMITED: true,
  PROVIDER_UNAVAILABLE: true,
  INTERNAL: true,
}

export function orkError(code: OrkErrorCode, overrides: Partial<Omit<OrkError, 'code'>> = {}): OrkError {
  return {
    code,
    message: overrides.message ?? DEFAULT_MESSAGES[code] ?? 'Something went wrong.',
    retryable: overrides.retryable ?? RETRYABLE[code] ?? false,
    ...(overrides.recovery ? { recovery: overrides.recovery } : {}),
    ...(overrides.legId ? { legId: overrides.legId } : {}),
  }
}

/** Error class for throwing across boundaries; serializes to OrkError. */
export class OrkException extends Error {
  readonly error: OrkError
  readonly status: number
  constructor(error: OrkError, status = 400) {
    super(error.message)
    this.error = error
    this.status = status
  }
}

export function isOrkError(value: unknown): value is OrkError {
  return !!value && typeof value === 'object' && 'code' in value && 'message' in value
}

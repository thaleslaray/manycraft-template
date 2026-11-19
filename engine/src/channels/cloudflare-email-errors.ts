/** Error codes of env.EMAIL.send(): https://developers.cloudflare.com/email-service/api/send-emails/workers-api/ (Error codes table).
 * Shared by the standalone binding sender and the workspace sender so both classify the same way. */

/** The docs publish no rate-limit window and no daily quota number (platform/limits.md). These waits are our own
 * conservative guesses, not Cloudflare values: a short one for the per-second limit and a long one for the daily quota. */
export const RATE_LIMIT_RETRY_SEC = 3
export const DAILY_LIMIT_RETRY_SEC = 3600

export type SendErrorEffect = 'pause_sending' | 'recipient_unreachable'
export type SendErrorClass =
  | { kind: 'rate_limited'; retryAfterSec: number; effect?: undefined }
  | { kind: 'rejected'; code: string; effect?: SendErrorEffect }
  | { kind: 'uncertain'; effect?: undefined }

export function classifySendError(error: unknown): SendErrorClass {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'E_RATE_LIMIT_EXCEEDED' || code === 'E_DAILY_LIMIT_EXCEEDED') return { kind: 'rate_limited', retryAfterSec: code === 'E_DAILY_LIMIT_EXCEEDED' ? DAILY_LIMIT_RETRY_SEC : RATE_LIMIT_RETRY_SEC }
  // E_DELIVERY_FAILED covers "SMTP delivery failure, recipient server rejection" without saying whether it is final,
  // so it is never auto-retried (could duplicate) nor reported as a definitive refusal.
  if (!code || code === 'E_INTERNAL_SERVER_ERROR' || code === 'E_DELIVERY_FAILED') return { kind: 'uncertain' }
  // Account paused for poor reputation, and recipient on the suppression list: retrying cannot help.
  if (code === 'E_ACCOUNT_SUSPENDED') return { kind: 'rejected', code, effect: 'pause_sending' }
  if (code === 'E_RECIPIENT_SUPPRESSED') return { kind: 'rejected', code, effect: 'recipient_unreachable' }
  return { kind: 'rejected', code }
}

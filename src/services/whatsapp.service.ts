import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

const FAST2SMS_WHATSAPP_URL = 'https://www.fast2sms.com/dev/whatsapp';

// Same {return, request_id, message, status_code} envelope as the old
// bulkV2 SMS route - Fast2SMS's WhatsApp OTP endpoint follows the same
// authorization/numbers/variables_values query-param convention, just
// pointed at a pre-approved WhatsApp "otp_verification" template
// (message_id + phone_number_id identify which one) instead of a route.
interface Fast2SmsWhatsappResponse {
  return: boolean;
  request_id?: string;
  message?: string[];
  status_code?: number;
}

function maskPhone(phone: string): string {
  return phone.length > 4 ? `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}` : phone;
}

async function sendViaFast2SmsWhatsapp(phone: string, otp: string): Promise<void> {
  const url = new URL(FAST2SMS_WHATSAPP_URL);
  url.searchParams.set('authorization', env.fast2smsApiKey);
  url.searchParams.set('message_id', env.fast2smsWhatsappMessageId);
  url.searchParams.set('phone_number_id', env.fast2smsWhatsappPhoneNumberId);
  url.searchParams.set('numbers', phone);
  url.searchParams.set('variables_values', otp);

  // fetch has no timeout of its own: without this an unresponsive Fast2SMS
  // holds the caller's HTTP request open indefinitely, and since OTP sends
  // happen during login, a provider outage would quietly pile up stuck
  // requests until the server ran out of sockets.
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(env.whatsappTimeoutMs),
    });
  } catch (err) {
    // Covers the timeout above and outright network failures alike - both
    // mean the same thing to the caller, and neither should surface as an
    // unhandled 500.
    console.error('[whatsapp.service] Fast2SMS WhatsApp request failed', {
      reason: err instanceof Error ? err.message : String(err),
      phone: maskPhone(phone),
    });
    throw new AppError(502, 'OTP_SEND_FAILED', 'Failed to send OTP via WhatsApp. Please try again shortly.');
  }

  let payload: Fast2SmsWhatsappResponse | undefined;
  try {
    payload = (await response.json()) as Fast2SmsWhatsappResponse;
  } catch {
    // fall through - payload stays undefined, handled below
  }

  if (!response.ok || payload?.return === false) {
    // payload.message is Fast2SMS's own human-readable error description
    // (e.g. "Invalid Authentication", "Wallet balance is low") - safe to
    // log. The API key, the OTP, and the rest of the raw payload are not.
    console.error('[whatsapp.service] Fast2SMS WhatsApp send failed', {
      status: response.status,
      statusCode: payload?.status_code,
      providerMessage: payload?.message,
      phone: maskPhone(phone),
    });
    throw new AppError(502, 'OTP_SEND_FAILED', 'Failed to send OTP via WhatsApp. Please try again shortly.');
  }
}

// Sends the real WhatsApp OTP unconditionally in every environment - dev and
// production both require an actual send and an actual matching code at
// verify time; there is no dummy-code shortcut. The only exception is a
// genuinely unconfigured provider (no API key/IDs at all), handled below.
export async function sendOtpWhatsapp(phone: string, otp: string): Promise<void> {
  if (!env.fast2smsApiKey || !env.fast2smsWhatsappPhoneNumberId || !env.fast2smsWhatsappMessageId) {
    if (env.nodeEnv === 'production') {
      throw new AppError(502, 'OTP_SEND_FAILED', 'WhatsApp provider is not configured.');
    }
    console.warn(`[whatsapp.service] WhatsApp OTP not configured - dev OTP for ${maskPhone(phone)}: ${otp}`);
    return;
  }

  await sendViaFast2SmsWhatsapp(phone, otp);
}

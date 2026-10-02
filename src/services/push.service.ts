import { JWT } from 'google-auth-library';
import { env } from '../config/env.js';

// FCM HTTP v1. Deliberately a hand-rolled fetch client rather than
// firebase-admin: the only thing the Admin SDK would add here is the OAuth
// dance, and google-auth-library - the library firebase-admin itself uses
// for exactly that - is already a dependency of this project for Google
// Sign-In. Pulling in the full SDK to reach one REST endpoint would be a
// large dependency for no capability this file doesn't already have, and
// whatsapp.service.ts sets the precedent of calling a provider over plain
// fetch.
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

// Must match the channel the Ionic client creates at startup (see the app's
// own push.service.ts). Android 8+ silently drops a notification whose
// channel_id doesn't exist on the device, so this constant is a contract
// between the two codebases, not a local detail.
export const ANDROID_CHANNEL_ID = 'earnivo_default';

export interface PushPayload {
  title: string;
  body: string;
  // FCM rejects any data value that isn't a string, so callers flatten
  // their metadata (ids, amounts) to strings first - see toPushData() in
  // notifications.service.ts.
  data?: Record<string, string>;
}

export interface PushResult {
  sent: number;
  failed: number;
  // Tokens FCM reported as permanently dead - the app was uninstalled, its
  // data was cleared, or the token belongs to another Firebase project. The
  // caller deletes these instead of retrying them forever.
  invalidTokens: string[];
}

export const pushConfigured = Boolean(env.firebaseProjectId && env.firebaseClientEmail && env.firebasePrivateKey);

// One JWT client for the process, not one per send. It caches the OAuth
// access token internally and only re-signs when the hour-long token nears
// expiry, so a broadcast of 500 messages performs one token exchange rather
// than 500.
let jwtClient: JWT | null = null;

function getJwtClient(): JWT {
  if (!jwtClient) {
    jwtClient = new JWT({
      email: env.firebaseClientEmail,
      key: env.firebasePrivateKey,
      scopes: [FCM_SCOPE],
    });
  }
  return jwtClient;
}

async function getAccessToken(): Promise<string | null> {
  try {
    const { token } = await getJwtClient().getAccessToken();
    return token ?? null;
  } catch (err) {
    // A malformed private key or a revoked service account lands here. Log
    // once for the whole send rather than once per token, and let the
    // caller treat the batch as failed - push is never load-bearing for a
    // request.
    console.error('[push.service] Failed to obtain an FCM access token', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

type SendOutcome = 'sent' | 'invalid' | 'failed';

async function sendOne(accessToken: string, token: string, payload: PushPayload): Promise<SendOutcome> {
  const message = {
    message: {
      token,
      // The notification block is what makes Android render a tray item by
      // itself while the app is backgrounded or killed. A data-only message
      // would be silent in exactly the case push matters most.
      notification: { title: payload.title, body: payload.body },
      // Duplicated into data on purpose: when the app IS in the foreground
      // the Capacitor listener receives this payload directly, and reading
      // title/body from one place keeps the in-app toast and the tray item
      // in step.
      data: { title: payload.title, body: payload.body, ...(payload.data ?? {}) },
      android: {
        // Wakes a dozing device. These are transactional messages - a
        // withdrawal being paid out, a reward landing - not marketing.
        priority: 'HIGH',
        notification: {
          channelId: ANDROID_CHANNEL_ID,
          defaultSound: true,
        },
      },
      // iOS isn't built yet, but an APNs block costs nothing now and is the
      // piece that's easy to forget later.
      apns: {
        payload: { aps: { sound: 'default' } },
      },
    },
  };

  let response: Response;
  try {
    response = await fetch(`https://fcm.googleapis.com/v1/projects/${env.firebaseProjectId}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(message),
      // Without this an unresponsive FCM would hold a socket open
      // indefinitely; during a broadcast that's one stuck socket per token.
      signal: AbortSignal.timeout(env.pushTimeoutMs),
    });
  } catch (err) {
    console.error('[push.service] FCM request failed', { reason: err instanceof Error ? err.message : String(err) });
    return 'failed';
  }

  if (response.ok) return 'sent';

  let body: any;
  try {
    body = await response.json();
  } catch {
    // fall through - handled as a generic failure below
  }

  const errorCode: string | undefined = body?.error?.details?.find((d: any) => typeof d?.errorCode === 'string')?.errorCode;

  // UNREGISTERED: the app instance is gone (uninstalled, or data cleared).
  // SENDER_ID_MISMATCH: the token was issued by a different Firebase
  // project. Both are permanent for this token, so it gets deleted.
  //
  // INVALID_ARGUMENT is deliberately NOT treated as a dead token: FCM
  // returns it for a malformed *message* too, so pruning on it would let a
  // payload bug quietly delete every device row in the database.
  if (errorCode === 'UNREGISTERED' || errorCode === 'SENDER_ID_MISMATCH' || response.status === 404) {
    return 'invalid';
  }

  console.error('[push.service] FCM rejected a message', {
    status: response.status,
    errorCode: errorCode ?? body?.error?.status ?? 'UNKNOWN',
    // FCM's own description ("The registration token is not a valid FCM
    // registration token"). The device token itself is never logged - it
    // identifies one specific user's device.
    message: body?.error?.message,
  });
  return 'failed';
}

// FCM v1 accepts exactly one token per request - the legacy
// registration_ids multicast endpoint was retired along with the legacy
// API - so a broadcast is genuinely N requests. This runs them in bounded
// parallel (env.pushConcurrency) instead of either a serial loop, which
// would take minutes for a platform-wide announcement, or an unbounded
// Promise.all, which would open a socket per user at once.
export async function sendPush(tokens: string[], payload: PushPayload): Promise<PushResult> {
  const empty: PushResult = { sent: 0, failed: 0, invalidTokens: [] };
  if (tokens.length === 0) return empty;

  if (!pushConfigured) {
    // Same escape hatch as whatsapp.service.ts and email.service.ts: with no
    // credentials there is nothing to deliver to, so log what would have
    // gone out and return successfully. Local development and tests never
    // need a Firebase service account, and no call site has to guard itself
    // with an "is push set up?" check.
    if (env.nodeEnv !== 'production') {
      console.info('[push.service] Push not configured - would have sent', {
        recipients: tokens.length,
        title: payload.title,
        body: payload.body,
      });
    }
    return empty;
  }

  const accessToken = await getAccessToken();
  if (!accessToken) return { sent: 0, failed: tokens.length, invalidTokens: [] };

  const result: PushResult = { sent: 0, failed: 0, invalidTokens: [] };
  let cursor = 0;

  // A fixed pool of workers pulling from a shared index, rather than
  // chunking into fixed slices: one slow token then can't stall a whole
  // slice behind it while other workers sit idle.
  const worker = async () => {
    while (cursor < tokens.length) {
      const token = tokens[cursor++]!;
      const outcome = await sendOne(accessToken, token, payload);
      if (outcome === 'sent') result.sent++;
      else if (outcome === 'invalid') result.invalidTokens.push(token);
      else result.failed++;
    }
  };

  await Promise.all(Array.from({ length: Math.min(env.pushConcurrency, tokens.length) }, worker));
  return result;
}

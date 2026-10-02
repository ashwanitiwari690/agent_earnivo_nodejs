import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { Errors } from '../../utils/AppError.js';
import { decryptToken, encryptToken } from '../../utils/crypto.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { fetchMyChannel } from '../youtube/youtube.service.js';
import type { GoogleAccountConnectionModel as GoogleAccountConnection } from '../../../generated/prisma/models.js';

// Authorization-code flow, hand-rolled over fetch for the same reason
// push.service.ts talks to FCM directly: the only thing a heavier client
// would add is what these three endpoints already are, and doing it here
// keeps the timeout, the error shape and the "never log a token" rule in one
// visible place. google-auth-library stays where it already was - verifying
// ID tokens for Google Sign-In (google-auth.service.ts) - which is a
// different flow that needs no client secret at all.
// Addresses come from config so the whole flow can be pointed at a local
// test double - see env.ts. The defaults are Google's own endpoints.
const GOOGLE_AUTH_ENDPOINT = env.googleAuthEndpoint;
const GOOGLE_TOKEN_ENDPOINT = env.googleTokenEndpoint;
const GOOGLE_REVOKE_ENDPOINT = env.googleRevokeEndpoint;

// The minimum that answers the only question this feature asks (spec §6:
// "Do not request unnecessary permissions"). youtube.readonly is what lets
// subscriptions.list run with mine=true - there is no narrower YouTube scope
// - and openid/email exist purely so a connection can be tied to a stable
// Google account id and shown back to its owner as a recognizable address.
// Notably absent: youtube.force-ssl (write access), youtubepartner, and
// anything touching Drive or profile data.
export const YOUTUBE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/youtube.readonly'];
const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

export type OwnerType = 'USER' | 'AGENT';

export const googleOAuthConfigured = Boolean(env.googleClientId && env.googleClientSecret);

function assertConfigured() {
  if (!googleOAuthConfigured) {
    throw Errors.conflict(
      'GOOGLE_OAUTH_NOT_CONFIGURED',
      'Google account connection is not configured on this server yet. Please try again later.',
    );
  }
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
//
// Google hands `state` straight back to the callback untouched, and the
// callback itself cannot be authenticated - the browser arriving there is
// coming from Google, not from an app carrying a bearer token. So state has
// to carry the identity, which means it has to be unforgeable: a signed,
// short-lived JWT rather than a random string paired with server-side
// session storage this API deliberately doesn't have. `typ` prevents an
// ordinary access token (signed with the same secret) from ever being
// accepted here as a state, and vice versa.
const STATE_TYPE = 'google_oauth_state';

interface StatePayload {
  typ: typeof STATE_TYPE;
  ownerType: OwnerType;
  ownerId: string;
  nonce: string;
}

function signState(ownerType: OwnerType, ownerId: string): string {
  const payload: StatePayload = { typ: STATE_TYPE, ownerType, ownerId, nonce: randomBytes(8).toString('hex') };
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: env.googleOauthStateTtlSeconds });
}

function verifyState(state: string): StatePayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(state, env.jwtAccessSecret);
  } catch {
    throw Errors.validation('This Google authorization link has expired. Please start again.');
  }
  const payload = decoded as Partial<StatePayload>;
  if (payload?.typ !== STATE_TYPE || !payload.ownerId || (payload.ownerType !== 'USER' && payload.ownerType !== 'AGENT')) {
    throw Errors.validation('Invalid Google authorization request.');
  }
  return payload as StatePayload;
}

// Where the browser is sent once the callback has stored the tokens. The
// agent panel has a real screen to return to; the Ionic app is inside a
// Capacitor in-app browser with no URL of its own, so it gets a
// backend-served confirmation page and re-reads its status when the browser
// closes. Never derived from a client-supplied parameter - that would make
// this an open redirect that a phishing link could point anywhere.
export function landingUrlFor(ownerType: OwnerType, params: Record<string, string>): string {
  const base = ownerType === 'AGENT' ? env.googleAgentRedirectUri : env.googleUserRedirectUri;
  if (!base) return '';
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${new URLSearchParams(params).toString()}`;
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(ownerType: OwnerType, ownerId: string): string {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: env.googleRedirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    // Without offline access Google returns an access token only, and the
    // whole feature would stop working an hour later with no way to recover
    // except sending the person back through consent every single time.
    access_type: 'offline',
    // Google only issues a refresh token on the FIRST authorization for a
    // given client+account pair. Someone reconnecting after a disconnect -
    // or connecting a second Earnivo account - would otherwise get an
    // access token with no refresh token and a connection that dies in an
    // hour, so consent is forced every time rather than reused.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: signState(ownerType, ownerId),
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function postToTokenEndpoint(body: Record<string, string>): Promise<GoogleTokenResponse> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(env.googleApiTimeoutMs),
    });
  } catch {
    throw Errors.conflict('GOOGLE_UNREACHABLE', 'Could not reach Google right now. Please try again in a moment.');
  }

  const payload = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!response.ok) {
    // Google's own error CODE is safe and useful (invalid_grant is the one
    // that actually means "revoked"); the description can echo request
    // content back, and the request contained a token - so only the code is
    // ever logged or surfaced.
    const error = payload.error ?? `http_${response.status}`;
    console.error('[google-oauth] token endpoint rejected the request', { error, status: response.status });
    throw Errors.conflict('GOOGLE_TOKEN_EXCHANGE_FAILED', 'Google rejected this authorization. Please connect your account again.');
  }
  return payload;
}

// Google's ID token is already signed and came straight from the token
// endpoint over TLS, so the claims are read without a second signature
// check - unlike google-auth.service.ts, which verifies an ID token handed
// to it by an untrusted client and therefore must.
function readIdentityFromIdToken(idToken: string | undefined): { sub: string; email: string | null } {
  if (!idToken) throw Errors.conflict('GOOGLE_TOKEN_EXCHANGE_FAILED', 'Google did not return an account identity. Please try again.');
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')) as { sub?: string; email?: string };
    if (!claims.sub) throw new Error('missing sub');
    return { sub: claims.sub, email: claims.email ?? null };
  } catch {
    throw Errors.conflict('GOOGLE_TOKEN_EXCHANGE_FAILED', 'Google did not return a readable account identity. Please try again.');
  }
}

function expiryFrom(expiresInSeconds: number | undefined): Date {
  // 3600s is Google's standard access-token lifetime; the fallback only
  // matters if that ever changes shape, and erring short just means one
  // extra refresh.
  return new Date(Date.now() + (expiresInSeconds ?? 3600) * 1000);
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

export interface CallbackResult {
  ownerType: OwnerType;
  redirectUrl: string;
  channelName?: string;
}

export async function handleCallback(code: string, state: string): Promise<CallbackResult> {
  assertConfigured();
  const { ownerType, ownerId } = verifyState(state);

  const tokens = await postToTokenEndpoint({
    code,
    client_id: env.googleClientId,
    client_secret: env.googleClientSecret,
    redirect_uri: env.googleRedirectUri,
    grant_type: 'authorization_code',
  });

  const grantedScopes = (tokens.scope ?? '').split(' ').filter(Boolean);
  if (!grantedScopes.includes(REQUIRED_SCOPE)) {
    // The person pressed Continue without ticking YouTube access. Google does
    // not pre-tick these boxes, so this is an easy and very common mistake -
    // the message names the exact checkbox rather than saying "a permission"
    // was missing, because "allow the YouTube permission" gives someone
    // staring at a list of checkboxes nothing to act on.
    //
    // Failing here beats storing a useless grant and only discovering it at
    // verification time, when YouTube answers 403 and the user has already
    // done the work of subscribing.
    throw Errors.validation(
      'YouTube access was not granted. Tap Connect again, and on the Google screen tick "View your YouTube account" (or Select all) before continuing.',
    );
  }
  if (!tokens.access_token) {
    throw Errors.conflict('GOOGLE_TOKEN_EXCHANGE_FAILED', 'Google did not return an access token. Please try connecting again.');
  }

  const identity = readIdentityFromIdToken(tokens.id_token);

  const data = {
    ownerType,
    googleAccountId: identity.sub,
    email: identity.email,
    accessTokenEncrypted: encryptToken(tokens.access_token),
    // Absent only if Google decided this account had already granted
    // consent. `prompt: 'consent'` above makes that very unlikely, but if it
    // happens the previously stored refresh token is the only thing that can
    // keep the connection alive - so it is preserved rather than nulled out.
    ...(tokens.refresh_token ? { refreshTokenEncrypted: encryptToken(tokens.refresh_token) } : {}),
    tokenExpiry: expiryFrom(tokens.expires_in),
    scopes: grantedScopes,
    status: 'CONNECTED' as const,
    lastRefreshedAt: new Date(),
  };

  const where = ownerType === 'AGENT' ? { agentId: ownerId } : { userId: ownerId };
  const connection = await prisma.googleAccountConnection.upsert({
    where,
    update: data,
    create: { ...data, ...(ownerType === 'AGENT' ? { agentId: ownerId } : { userId: ownerId }) },
  });

  let channelName: string | undefined;
  if (ownerType === 'AGENT') {
    channelName = (await syncAgentChannel(ownerId, connection.id, tokens.access_token)).youtubeChannelName;
  }

  await writeAuditLog({
    action: 'GOOGLE_ACCOUNT_CONNECTED',
    entityType: 'google_account_connections',
    entityId: connection.id,
    // googleAccountId, not a token: enough to answer "which account was
    // connected" in a support ticket, and worthless to anyone who reads it.
    metadata: { ownerType, googleAccountId: identity.sub, scopes: grantedScopes },
  });

  return { ownerType, redirectUrl: landingUrlFor(ownerType, { google: 'connected' }), channelName };
}

// Resolves (or re-resolves) which YouTube channel the agent's authorized
// Google account actually owns. This call - not anything the agent typed -
// is what makes a channel id trustworthy enough for a campaign to target.
export async function syncAgentChannel(agentId: string, googleConnectionId: string, accessToken: string) {
  const channel = await fetchMyChannel(accessToken);
  if (!channel) {
    throw Errors.conflict(
      'NO_YOUTUBE_CHANNEL',
      'This Google account does not have a YouTube channel. Please connect the Google account that owns your channel.',
    );
  }

  const data = {
    agentId,
    googleConnectionId,
    youtubeChannelId: channel.id,
    youtubeChannelName: channel.title,
    thumbnailUrl: channel.thumbnailUrl,
    channelUrl: channel.channelUrl,
  };
  return prisma.youTubeConnection.upsert({ where: { agentId }, update: data, create: data });
}

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

async function markReauthRequired(connectionId: string) {
  await prisma.googleAccountConnection.update({
    where: { id: connectionId },
    // The access token is cleared but the row is kept: the owner's UI needs
    // to show WHICH account has gone stale, and for an agent the linked
    // YouTubeConnection (and therefore any running campaign's target
    // channel) must survive a token expiry untouched.
    data: { status: 'REAUTH_REQUIRED', accessTokenEncrypted: null, tokenExpiry: null },
  });
}

// Refreshed a minute early rather than exactly at expiry, so a token that is
// valid when checked cannot expire mid-flight during the YouTube call it was
// fetched for.
const EXPIRY_SKEW_MS = 60_000;

// The single entry point for "give me a usable access token for this
// connection". Every YouTube call goes through it, so the refresh logic
// exists once and no call site has to remember to check expiry first.
export async function getValidAccessToken(connection: GoogleAccountConnection): Promise<string> {
  assertConfigured();
  if (connection.status === 'DISCONNECTED') throw Errors.googleReauthRequired('This Google account has been disconnected. Please connect it again.');

  const stillValid = connection.tokenExpiry != null && connection.tokenExpiry.getTime() - EXPIRY_SKEW_MS > Date.now();
  if (stillValid && connection.status === 'CONNECTED') {
    const accessToken = decryptToken(connection.accessTokenEncrypted);
    if (accessToken) return accessToken;
    // Falls through to refresh: an undecryptable access token (rotated key,
    // corrupted row) is recoverable as long as the refresh token still
    // decrypts, so this is not yet a reason to make someone reconnect.
  }

  const refreshToken = decryptToken(connection.refreshTokenEncrypted);
  if (!refreshToken) {
    await markReauthRequired(connection.id);
    throw Errors.googleReauthRequired();
  }

  let tokens: GoogleTokenResponse;
  try {
    tokens = await postToTokenEndpoint({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
  } catch (err) {
    // A refresh that Google actively rejected means the grant is gone -
    // revoked from the person's Google account settings, or the password was
    // changed. That is permanent, so the connection is marked for
    // reconnection. A network/timeout failure is not, and is re-thrown
    // as-is so a momentary outage never wipes a working connection.
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'GOOGLE_TOKEN_EXCHANGE_FAILED') {
      await markReauthRequired(connection.id);
      throw Errors.googleReauthRequired('Google access was revoked. Please reconnect your Google account.');
    }
    throw err;
  }

  if (!tokens.access_token) {
    await markReauthRequired(connection.id);
    throw Errors.googleReauthRequired();
  }

  await prisma.googleAccountConnection.update({
    where: { id: connection.id },
    data: {
      accessTokenEncrypted: encryptToken(tokens.access_token),
      tokenExpiry: expiryFrom(tokens.expires_in),
      // A refresh response usually omits refresh_token, which means "keep
      // using the one you have" - never "the connection lost its refresh
      // token".
      ...(tokens.refresh_token ? { refreshTokenEncrypted: encryptToken(tokens.refresh_token) } : {}),
      status: 'CONNECTED',
      lastRefreshedAt: new Date(),
    },
  });

  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// Reads / disconnect
// ---------------------------------------------------------------------------

export function findConnection(ownerType: OwnerType, ownerId: string) {
  return prisma.googleAccountConnection.findUnique({
    where: ownerType === 'AGENT' ? { agentId: ownerId } : { userId: ownerId },
  });
}

// The ONLY shape a connection is ever exposed in. Building it by hand rather
// than spreading the row is the point: a future column cannot leak into an
// API response by accident, and the two token columns are structurally
// impossible to include here (spec §15).
export function serializeConnection(connection: GoogleAccountConnection | null) {
  if (!connection || connection.status === 'DISCONNECTED') return { connected: false as const };
  return {
    connected: true as const,
    googleAccountId: connection.googleAccountId,
    email: connection.email,
    status: connection.status,
    scopes: connection.scopes,
    // The moment the *access* token lapses, not the connection - useful for
    // support, and harmless: knowing when a token expires reveals nothing
    // about the token itself.
    tokenExpiry: connection.tokenExpiry,
    connectedAt: connection.createdAt,
    // What the UI actually branches on, so no client has to re-derive the
    // rule from a status string it might read differently.
    reconnectRequired: connection.status === 'REAUTH_REQUIRED',
  };
}

export async function getAgentConnection(agentId: string) {
  const connection = await findConnection('AGENT', agentId);
  const youtube = await prisma.youTubeConnection.findUnique({ where: { agentId } });
  return {
    google: serializeConnection(connection),
    youtube: youtube
      ? {
          channelId: youtube.youtubeChannelId,
          channelName: youtube.youtubeChannelName,
          thumbnailUrl: youtube.thumbnailUrl,
          channelUrl: youtube.channelUrl,
          connectedAt: youtube.createdAt,
          updatedAt: youtube.updatedAt,
        }
      : null,
  };
}

export async function getUserConnection(userId: string) {
  return { google: serializeConnection(await findConnection('USER', userId)) };
}

// Re-reads the channel from YouTube using the agent's existing grant - for
// an agent who renamed their channel or changed its avatar and wants Earnivo
// to catch up without going through consent again.
export async function refreshAgentChannel(agentId: string) {
  const connection = await findConnection('AGENT', agentId);
  if (!connection) throw Errors.notFound('Google account connection');
  const accessToken = await getValidAccessToken(connection);
  await syncAgentChannel(agentId, connection.id, accessToken);
  return getAgentConnection(agentId);
}

// Best-effort: Google is told to drop the grant, then the row goes either
// way. Leaving a local row behind because Google was briefly unreachable
// would mean the person clicked Disconnect and stayed connected, which is
// the worse of the two failures.
async function revokeAtGoogle(token: string | null) {
  if (!token) return;
  try {
    await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(env.googleApiTimeoutMs),
    });
  } catch (err) {
    console.error('[google-oauth] revoke call failed', { reason: err instanceof Error ? err.message : 'unknown' });
  }
}

export async function disconnect(ownerType: OwnerType, ownerId: string) {
  const connection = await findConnection(ownerType, ownerId);
  if (!connection) return { disconnected: true };

  // Revoking the refresh token invalidates every access token issued under
  // it too, so one call retires the whole grant.
  await revokeAtGoogle(decryptToken(connection.refreshTokenEncrypted) ?? decryptToken(connection.accessTokenEncrypted));

  // Deleted rather than flagged, so no ciphertext is kept for an account the
  // person has explicitly disconnected (spec §15). For an agent this
  // cascades to their YouTubeConnection - already-created campaigns are
  // untouched, since each snapshotted its own target channel id at creation.
  await prisma.googleAccountConnection.delete({ where: { id: connection.id } });

  await writeAuditLog({
    action: 'GOOGLE_ACCOUNT_DISCONNECTED',
    entityType: 'google_account_connections',
    entityId: connection.id,
    metadata: { ownerType, googleAccountId: connection.googleAccountId },
  });

  return { disconnected: true };
}

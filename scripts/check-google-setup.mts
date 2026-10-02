// Diagnostic for the Google / YouTube integration:  npm run check:google
//
// Walks the whole chain in order and stops being useful exactly where the
// real thing would break, so the output names the next action rather than
// just failing. Deliberately calls the application's OWN service functions
// (getValidAccessToken, fetchMyChannel, isSubscribedToChannel) rather than
// re-implementing them - a diagnostic that passes while the app fails would
// be worse than none at all.
//
// Never prints a token. Only whether one exists and whether it decrypts.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../src/config/env.js';
import { decryptToken } from '../src/utils/crypto.js';
import { getValidAccessToken, googleOAuthConfigured } from '../src/modules/google-oauth/google-oauth.service.js';
import { fetchMyChannel, isSubscribedToChannel } from '../src/modules/youtube/youtube.service.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

// A public channel used only to prove the subscriptions endpoint answers at
// all for a USER grant. Whether the answer is true or false is irrelevant -
// what matters is that YouTube responded instead of rejecting the call.
const PROBE_CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw'; // Google for Developers

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const info = (m: string) => console.log(`    ${m}`);
const step = (n: number, m: string) => console.log(`\n${n}. ${m}`);

let blocker: string | null = null;
function block(message: string) {
  if (!blocker) blocker = message;
}

// --- 1. Configuration ------------------------------------------------------
step(1, 'Configuration (nodejs/.env)');
const required: [string, string][] = [
  ['GOOGLE_CLIENT_ID', env.googleClientId],
  ['GOOGLE_CLIENT_SECRET', env.googleClientSecret],
  ['GOOGLE_REDIRECT_URI', env.googleRedirectUri],
];
for (const [name, value] of required) {
  if (value) ok(`${name} set${name.endsWith('URI') ? `: ${value}` : ` (${value.length} chars)`}`);
  else bad(`${name} is MISSING`);
}
if (env.tokenEncryptionKey) ok('TOKEN_ENCRYPTION_KEY set');
else info('TOKEN_ENCRYPTION_KEY not set - falling back to JWT_ACCESS_SECRET (tokens are still encrypted)');

if (!googleOAuthConfigured) {
  bad('Google OAuth is NOT configured - the connect endpoints will answer GOOGLE_OAUTH_NOT_CONFIGURED');
  block('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in nodejs/.env, then restart the backend.');
} else {
  ok('Google OAuth is configured');
  const projectNumber = env.googleClientId.split('-')[0];
  info(`Google Cloud project number: ${projectNumber}`);
}

// --- 2. Credentials, against Google ---------------------------------------
// Google validates client_id + secret BEFORE it looks at the code, so a
// deliberately invalid code separates the two failures cleanly:
//   invalid_client -> the id/secret pair is wrong
//   invalid_grant  -> the pair was accepted, only the fake code was rejected
step(2, 'Client ID + secret (Google token endpoint)');
if (googleOAuthConfigured) {
  try {
    const res = await fetch(env.googleTokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: 'diagnostic-invalid-code',
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        redirect_uri: env.googleRedirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(env.googleApiTimeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === 'invalid_grant') ok('Google accepted the client ID and secret');
    else if (body.error === 'invalid_client') {
      bad('Google rejected the client ID or secret (invalid_client)');
      block('Re-copy GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from the Cloud Console.');
    } else info(`unexpected response: ${body.error ?? JSON.stringify(body).slice(0, 120)}`);
  } catch (err) {
    bad(`could not reach Google: ${(err as Error).message}`);
  }
} else {
  info('skipped - not configured');
}

// --- 3. Redirect URI registration -----------------------------------------
// Google renders an error page instead of the consent screen when the
// redirect_uri is not registered on this client.
step(3, 'Redirect URI registration (Google consent screen)');
if (googleOAuthConfigured) {
  try {
    const url = `${env.googleAuthEndpoint}?${new URLSearchParams({
      client_id: env.googleClientId,
      redirect_uri: env.googleRedirectUri,
      response_type: 'code',
      scope: 'openid email https://www.googleapis.com/auth/youtube.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state: 'diagnostic',
    })}`;
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(env.googleApiTimeoutMs) });
    const html = await res.text();
    const problems: [string, string][] = [
      ['redirect_uri_mismatch', `redirect_uri is NOT registered on this client: ${env.googleRedirectUri}`],
      ['deleted_client', 'this OAuth client has been deleted'],
      ['unauthorized_client', 'this client is not authorised for the authorization-code flow'],
    ];
    const hit = problems.find(([needle]) => html.includes(needle));
    if (hit) {
      bad(hit[1]);
      block(`Add ${env.googleRedirectUri} to the client's Authorized redirect URIs, exactly as written.`);
    } else if (/Sign in|Choose an account|consent/i.test(html)) {
      ok('Google served the sign-in / consent screen - redirect URI accepted');
    } else {
      info('inconclusive - could not classify Google’s response');
    }
  } catch (err) {
    bad(`could not reach Google: ${(err as Error).message}`);
  }
} else {
  info('skipped - not configured');
}

// --- 4. Stored connections ------------------------------------------------
step(4, 'Connected accounts (database)');
const connections = await prisma.googleAccountConnection.findMany({ include: { youtubeConnection: true } });
if (connections.length === 0) {
  info('No Google account has been connected yet.');
  block(
    'Connect one: start the backend (npm run dev), then in the Agent panel go to ' +
      'Settings → YouTube Account → Connect. In the Ionic app: Profile → YouTube Verification Account.',
  );
} else {
  ok(`${connections.length} connection(s) stored`);
}

// --- 5. Live YouTube API --------------------------------------------------
// The only step that actually proves YouTube data access. Everything above
// can pass while this fails, most often because the YouTube Data API is not
// enabled on the project.
step(5, 'Live YouTube API calls');
if (connections.length === 0) {
  info('skipped - nothing to call YouTube with (a user grant is required; an API key cannot do this)');
}

for (const connection of connections) {
  const who = `${connection.ownerType} ${connection.email ?? connection.googleAccountId}`;
  console.log(`\n  [${who}]`);
  info(`status=${connection.status}  scopes=${connection.scopes.join(', ') || 'none'}`);
  info(`access token ${connection.accessTokenEncrypted ? 'stored' : 'ABSENT'}, refresh token ${connection.refreshTokenEncrypted ? 'stored' : 'ABSENT'}`);

  if (connection.refreshTokenEncrypted && !decryptToken(connection.refreshTokenEncrypted)) {
    bad('refresh token cannot be decrypted - TOKEN_ENCRYPTION_KEY has changed since it was stored');
    block('Restore the previous TOKEN_ENCRYPTION_KEY, or have everyone reconnect.');
    continue;
  }

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(connection);
    ok('obtained a valid access token (refreshed automatically if it had expired)');
  } catch (err) {
    bad(`could not obtain an access token: ${(err as Error).message}`);
    block('Reconnect this Google account.');
    continue;
  }

  try {
    const channel = await fetchMyChannel(accessToken);
    if (channel) ok(`channels?mine=true -> "${channel.title}" (${channel.id})`);
    else info('channels?mine=true -> this Google account has no YouTube channel');
  } catch (err) {
    bad(`channels?mine=true failed: ${(err as Error).message}`);
    block('Check that YouTube Data API v3 is enabled on this Google Cloud project.');
    continue;
  }

  try {
    const subscribed = await isSubscribedToChannel(accessToken, PROBE_CHANNEL_ID);
    ok(`subscriptions?mine=true answered (subscribed to the probe channel: ${subscribed})`);
    info('This is the exact call that decides a YOUTUBE_SUBSCRIBE reward.');
  } catch (err) {
    bad(`subscriptions?mine=true failed: ${(err as Error).message}`);
    block('Check that YouTube Data API v3 is enabled on this Google Cloud project.');
  }

  if (connection.ownerType === 'AGENT') {
    if (connection.youtubeConnection) {
      ok(`verified channel saved: "${connection.youtubeConnection.youtubeChannelName}" (${connection.youtubeConnection.youtubeChannelId})`);
    } else {
      bad('no verified channel saved for this agent - YouTube Subscribe campaigns will be blocked');
    }
  }
}

// --- 6. Campaign readiness ------------------------------------------------
step(6, 'Campaign readiness');
const campaignType = await prisma.campaignType.findUnique({ where: { code: 'YOUTUBE_SUBSCRIBE' } });
if (!campaignType) bad('YOUTUBE_SUBSCRIBE campaign type is missing - run: npm run prisma:seed');
else if (!campaignType.isActive) bad('YOUTUBE_SUBSCRIBE is inactive - run: npm run prisma:seed');
else ok('YOUTUBE_SUBSCRIBE campaign type is active');

if (campaignType && Number(campaignType.rewardAmount) === 0) {
  bad(`reward is ${campaignType.rewardAmount} - a completed task would credit nothing`);
  block('Set the YOUTUBE_SUBSCRIBE reward in the Admin panel (campaign type rewards).');
} else if (campaignType) {
  ok(`reward per completion: ${campaignType.rewardAmount} ${campaignType.currency}`);
}

// --- verdict ---------------------------------------------------------------
console.log('\n' + '-'.repeat(70));
if (blocker) console.log(`NEXT STEP: ${blocker}`);
else console.log('All checks passed - YouTube data access is working end to end.');
console.log('-'.repeat(70));

await prisma.$disconnect();

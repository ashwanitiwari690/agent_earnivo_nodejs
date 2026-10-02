// End-to-end run of the YouTube Subscribe verification scenarios (spec §23).
//
// The backend runs as a real process and makes real HTTP calls; only Google
// itself is replaced, by a stub the four GOOGLE_OAUTH_*_URL /
// YOUTUBE_API_BASE_URL env vars point at. Nothing in the application branches
// on that - the token exchange, the refresh, the YouTube reads and the error
// mapping are all the production code paths.
import { spawn, type ChildProcess } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { signAccessToken } from '../src/utils/jwt.js';
// @ts-expect-error - plain .mjs test double, no types by design
import { start as startStub, stop as stopStub, state as stub } from './google-stub.mjs';

const STUB_PORT = 4398;
const API_PORT = 4399;
const API = `http://127.0.0.1:${API_PORT}/api`;

const AGENT_GOOGLE_ID = 'google-agent-001';
const USER_GOOGLE_ID = 'google-user-001';
const OTHER_GOOGLE_ID = 'google-user-other';
const CHANNEL_ID = 'UCtest_agent_channel_0001';
const REWARD = 25;

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

// Captured at setup so cleanup can put the admin-configured reward back.
let previousRewardAmount: unknown = null;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML page (the OAuth landing) or a redirect body */
  }
  return { status: res.status, body: json, text, location: res.headers.get('location') };
}

// --- fixtures -------------------------------------------------------------

async function resetFixtures() {
  await prisma.user.deleteMany({ where: { email: { in: ['yt-agent@test.local', 'yt-user@test.local'] } } });

  const [agentRole, userRole] = await Promise.all([
    prisma.role.findUniqueOrThrow({ where: { code: 'AGENT' } }),
    prisma.role.findUniqueOrThrow({ where: { code: 'USER' } }),
  ]);

  const agentUser = await prisma.user.create({
    data: { email: 'yt-agent@test.local', name: 'YT Agent', roleId: agentRole.id, emailVerified: true, status: 'ACTIVE' },
  });
  const agent = await prisma.agentProfile.create({
    data: { userId: agentUser.id, name: 'YT Agent', email: 'yt-agent@test.local', status: 'ACTIVE', verificationStatus: 'VERIFIED' },
  });
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'PROFESSIONAL' } });
  await prisma.agentSubscription.create({
    data: { agentId: agent.id, planId: plan.id, status: 'ACTIVE', startedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 86400_000) },
  });
  await prisma.subscriptionUsage.create({ data: { agentId: agent.id } });

  const user = await prisma.user.create({
    data: { email: 'yt-user@test.local', name: 'YT User', roleId: userRole.id, status: 'ACTIVE' },
  });
  await prisma.userWallet.create({ data: { userId: user.id, balance: 0 } });

  // A non-zero reward so "was the wallet credited" is a real assertion. The
  // previous value is restored in cleanup, so running this never silently
  // rewrites an admin-configured reward.
  const campaignType = await prisma.campaignType.findUniqueOrThrow({ where: { code: 'YOUTUBE_SUBSCRIBE' } });
  previousRewardAmount = campaignType.rewardAmount;
  await prisma.campaignType.update({ where: { code: 'YOUTUBE_SUBSCRIBE' }, data: { rewardAmount: REWARD } });

  return {
    agent,
    agentToken: signAccessToken({ sub: agentUser.id, role: 'AGENT' }),
    user,
    userToken: signAccessToken({ sub: user.id, role: 'USER' }),
  };
}

// Drives the real OAuth callback: reads the authorize URL the backend built,
// lifts its signed `state`, hands the stub a matching code, then calls the
// callback exactly as a browser returning from Google would.
async function completeOAuth(role: 'agent' | 'user', token: string, googleAccountId: string, email: string) {
  const authorize = await call('GET', `/google-oauth/${role}/authorize-url`, token);
  const state = new URL(authorize.body.data.authUrl).searchParams.get('state')!;
  const code = `code_${googleAccountId}_${Date.now()}`;
  stub.codes.set(code, { googleAccountId, email });
  return call('GET', `/google-oauth/callback?code=${code}&state=${encodeURIComponent(state)}`);
}

async function walletOf(userId: string) {
  const wallet = await prisma.userWallet.findUniqueOrThrow({ where: { userId } });
  const transactions = await prisma.walletTransaction.count({ where: { userId, referenceType: 'TASK_COMPLETION' } });
  return { balance: Number(wallet.balance), transactions };
}

// Creates a YOUTUBE_SUBSCRIBE campaign + its task through the real agent API,
// then flips it ACTIVE directly - admin approval is a separate, already-tested
// workflow and not what these scenarios are about.
async function createLiveCampaign(agentToken: string, name: string) {
  const created = await call('POST', '/campaigns', agentToken, {
    campaignTypeCode: 'YOUTUBE_SUBSCRIBE',
    campaignName: name,
    description: 'Subscribe to our channel to earn a reward.',
    // Deliberately sent, and deliberately expected to be ignored: the target
    // must come from the verified connection, never from the request.
    destinationUrl: 'https://www.youtube.com/channel/UCsomeone_elses_channel',
  });
  if (created.status !== 201 && created.status !== 200) throw new Error(`campaign create failed: ${created.text}`);
  const campaign = created.body.data;

  const task = await call('POST', `/campaigns/${campaign.id}/tasks`, agentToken, {
    title: name,
    type: 'TASK',
    instructions: 'Subscribe to the channel.',
    configuration: {},
  });
  if (task.status !== 201 && task.status !== 200) throw new Error(`task create failed: ${task.text}`);

  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'ACTIVE', startsAt: new Date(), approvedAt: new Date() } });
  return { campaign, taskId: task.body.data.id };
}

// --- run ------------------------------------------------------------------

let api: ChildProcess | undefined;

async function startApi() {
  api = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(API_PORT),
      CLUSTER_WORKERS: '1',
      HTTP_LOG_ENABLED: 'false',
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_REDIRECT_URI: `http://127.0.0.1:${API_PORT}/api/google-oauth/callback`,
      GOOGLE_AGENT_REDIRECT_URI: '',
      GOOGLE_USER_REDIRECT_URI: '',
      GOOGLE_OAUTH_AUTH_URL: `http://127.0.0.1:${STUB_PORT}/auth`,
      GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${STUB_PORT}/token`,
      GOOGLE_OAUTH_REVOKE_URL: `http://127.0.0.1:${STUB_PORT}/revoke`,
      YOUTUBE_API_BASE_URL: `http://127.0.0.1:${STUB_PORT}/youtube`,
      TOKEN_ENCRYPTION_KEY: 'youtube-scenarios-test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));

  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API did not start');
}

async function main() {
  await startStub(STUB_PORT);
  await startApi();
  const { agent, agentToken, user, userToken } = await resetFixtures();

  // The agent's Google account owns a channel; the user's owns none and is
  // not subscribed to anything yet.
  stub.accounts.set(AGENT_GOOGLE_ID, {
    channel: { id: CHANNEL_ID, title: 'Agent Test Channel', customUrl: '@agenttestchannel', thumbnailUrl: 'https://example.test/thumb.jpg' },
    subscriptions: new Set<string>(),
  });
  stub.accounts.set(USER_GOOGLE_ID, { subscriptions: new Set<string>() });
  stub.accounts.set(OTHER_GOOGLE_ID, { subscriptions: new Set<string>() });

  // --- Scenario 8: agent has no connected channel ------------------------
  console.log('\nScenario 8 - agent creates campaign with no connected YouTube channel');
  const blocked = await call('POST', '/campaigns', agentToken, {
    campaignTypeCode: 'YOUTUBE_SUBSCRIBE',
    campaignName: 'Should be blocked',
    description: 'Blocked before any channel is connected.',
  });
  check('campaign creation is refused', blocked.status === 409, blocked.body);
  check('error code is YOUTUBE_CHANNEL_NOT_CONNECTED', blocked.body?.error?.code === 'YOUTUBE_CHANNEL_NOT_CONNECTED', blocked.body?.error);

  // --- Agent connects ----------------------------------------------------
  console.log('\nAgent flow - connect Google, resolve verified channel');
  const agentCallback = await completeOAuth('agent', agentToken, AGENT_GOOGLE_ID, 'agent@gmail.test');
  check('callback completes', agentCallback.status === 200 || agentCallback.status === 302, agentCallback.status);
  const agentConnection = await call('GET', '/google-oauth/agent/connection', agentToken);
  check('agent connection reports connected', agentConnection.body?.data?.google?.connected === true, agentConnection.body);
  check('verified channel id resolved from YouTube', agentConnection.body?.data?.youtube?.channelId === CHANNEL_ID, agentConnection.body?.data?.youtube);
  check('no token field is ever exposed', !JSON.stringify(agentConnection.body).match(/accessToken|refreshToken|_encrypted/i));

  const storedAgent = await prisma.googleAccountConnection.findUniqueOrThrow({ where: { agentId: agent.id } });
  check('access token is stored encrypted', storedAgent.accessTokenEncrypted?.startsWith('v1:') === true);
  check('refresh token is stored encrypted', storedAgent.refreshTokenEncrypted?.startsWith('v1:') === true);

  // --- Scenario 9: campaign target cannot be anything but the verified channel
  console.log('\nScenario 9 - campaign channel vs. agent connected channel');
  const { campaign, taskId } = await createLiveCampaign(agentToken, 'Subscribe Test Campaign');
  check('campaign targets the verified channel', campaign.youtubeChannelId === CHANNEL_ID, campaign.youtubeChannelId);
  check('agent-supplied destination URL is overridden', campaign.destinationUrl?.includes('agenttestchannel') === true, campaign.destinationUrl);

  // --- Start without a connected user account ----------------------------
  console.log('\nUser flow - start task before connecting Google');
  const earlyStart = await call('POST', `/tasks/${taskId}/start`, userToken, {});
  check('start is refused', earlyStart.status === 409, earlyStart.body);
  check('error code is GOOGLE_ACCOUNT_NOT_CONNECTED', earlyStart.body?.error?.code === 'GOOGLE_ACCOUNT_NOT_CONNECTED', earlyStart.body?.error);

  // --- User connects -----------------------------------------------------
  await completeOAuth('user', userToken, USER_GOOGLE_ID, 'user@gmail.test');
  const userConnection = await call('GET', '/google-oauth/user/connection', userToken);
  check('user connection reports connected', userConnection.body?.data?.google?.connected === true, userConnection.body);

  // --- Scenario 2: started but not subscribed ----------------------------
  console.log('\nScenario 2 - task started, user has not subscribed');
  const started = await call('POST', `/tasks/${taskId}/start`, userToken, {});
  check('task starts', started.status === 201, started.body);
  check('start returns the channel to open', started.body?.data?.youtubeChannelId === CHANNEL_ID, started.body?.data);

  const notSubscribed = await call('POST', `/tasks/${taskId}/verify-youtube-subscription`, userToken, {});
  check('verify answers 200 (not an error)', notSubscribed.status === 200, notSubscribed.status);
  check('verified is false', notSubscribed.body?.data?.verified === false, notSubscribed.body?.data);
  check('status stays WAITING_FOR_VERIFICATION', notSubscribed.body?.data?.status === 'WAITING_FOR_VERIFICATION', notSubscribed.body?.data);
  const afterNotSubscribed = await walletOf(user.id);
  check('no reward credited', afterNotSubscribed.balance === 0, afterNotSubscribed);

  // A self-confirmation submit must not be able to credit this task.
  const submitted = await call('POST', `/task-completions/${started.body.data.completionId}/submit`, userToken, { data: {} });
  check('in-app submit is refused', submitted.body?.error?.code === 'YOUTUBE_VERIFICATION_REQUIRED', submitted.body?.error);
  const completionAfterSubmit = await prisma.userTaskCompletion.findUniqueOrThrow({ where: { id: started.body.data.completionId } });
  check('refused submit left the attempt untouched', completionAfterSubmit.status === 'STARTED', completionAfterSubmit.status);

  // --- Scenario 3: subscribed with a DIFFERENT Google account ------------
  console.log('\nScenario 3 - subscribed, but as a different Google account');
  stub.accounts.get(OTHER_GOOGLE_ID).subscriptions.add(CHANNEL_ID);
  const mismatch = await call('POST', `/tasks/${taskId}/verify-youtube-subscription`, userToken, {});
  check('verification still fails', mismatch.body?.data?.verified === false, mismatch.body?.data);
  check('message names the account mismatch', /same Google account/i.test(mismatch.body?.data?.message ?? ''), mismatch.body?.data?.message);
  check('still no reward', (await walletOf(user.id)).balance === 0);

  // --- Scenario 1: subscribed with the connected account -----------------
  console.log('\nScenario 1 - subscribed with the connected Google account');
  stub.accounts.get(USER_GOOGLE_ID).subscriptions.add(CHANNEL_ID);
  const verified = await call('POST', `/tasks/${taskId}/verify-youtube-subscription`, userToken, {});
  check('verified is true', verified.body?.data?.verified === true, verified.body?.data);
  check('status is COMPLETED', verified.body?.data?.status === 'COMPLETED', verified.body?.data);
  check('reward amount returned', Number(verified.body?.data?.rewardAmount) === REWARD, verified.body?.data?.rewardAmount);
  const afterVerified = await walletOf(user.id);
  check('wallet credited once', afterVerified.balance === REWARD && afterVerified.transactions === 1, afterVerified);

  const verificationRow = await prisma.youTubeTaskVerification.findFirstOrThrow({ where: { taskId, userId: user.id } });
  check('verification recorded as VERIFIED', verificationRow.status === 'VERIFIED', verificationRow.status);
  check('verification method recorded', verificationRow.verificationMethod === 'YOUTUBE_OAUTH', verificationRow.verificationMethod);
  check('verifiedAt stamped', verificationRow.verifiedAt != null);
  check('channel checked is the campaign channel', verificationRow.youtubeChannelId === CHANNEL_ID);

  // --- Scenario 5: repeated verification -------------------------------
  console.log('\nScenario 5 - verify called repeatedly after completion');
  const repeat1 = await call('POST', `/tasks/${taskId}/verify-youtube-subscription`, userToken, {});
  const repeat2 = await call('POST', `/tasks/${taskId}/verify-youtube-subscription`, userToken, {});
  check('repeat returns COMPLETED', repeat1.body?.data?.status === 'COMPLETED' && repeat2.body?.data?.status === 'COMPLETED');
  check('repeat is flagged alreadyCompleted', repeat1.body?.data?.alreadyCompleted === true, repeat1.body?.data);
  const afterRepeats = await walletOf(user.id);
  check('no duplicate reward', afterRepeats.balance === REWARD && afterRepeats.transactions === 1, afterRepeats);

  // Two concurrent calls on a fresh attempt is the case the guarded update
  // and the unique index exist for - worth exercising directly.
  console.log('\nDuplicate-reward guard - two concurrent verifications of one fresh attempt');
  const second = await createLiveCampaign(agentToken, 'Concurrent Verify Campaign');
  await call('POST', `/tasks/${second.taskId}/start`, userToken, {});
  const [raceA, raceB] = await Promise.all([
    call('POST', `/tasks/${second.taskId}/verify-youtube-subscription`, userToken, {}),
    call('POST', `/tasks/${second.taskId}/verify-youtube-subscription`, userToken, {}),
  ]);
  const afterRace = await walletOf(user.id);
  check('both calls report COMPLETED', raceA.body?.data?.status === 'COMPLETED' && raceB.body?.data?.status === 'COMPLETED', [raceA.body?.data, raceB.body?.data]);
  check('exactly one extra credit', afterRace.balance === REWARD * 2 && afterRace.transactions === 2, afterRace);

  // --- Scenario 4: already subscribed before starting --------------------
  console.log('\nScenario 4 - user was already subscribed before starting');
  const third = await createLiveCampaign(agentToken, 'Pre-subscribed Campaign');
  const preStart = await call('POST', `/tasks/${third.taskId}/start`, userToken, {});
  check('task starts normally', preStart.status === 201, preStart.body);
  const preVerified = await call('POST', `/tasks/${third.taskId}/verify-youtube-subscription`, userToken, {});
  check('verification passes on an existing subscription', preVerified.body?.data?.verified === true, preVerified.body?.data);

  // --- Scenario 6: expired access token, valid refresh token -------------
  console.log('\nScenario 6 - access token expired, refresh token valid');
  await prisma.googleAccountConnection.update({
    where: { userId: user.id },
    data: { tokenExpiry: new Date(Date.now() - 60_000) },
  });
  const before = stub.requestLog.filter((r: string) => r === 'POST /token').length;
  const fourth = await createLiveCampaign(agentToken, 'Token Refresh Campaign');
  await call('POST', `/tasks/${fourth.taskId}/start`, userToken, {});
  const refreshed = await call('POST', `/tasks/${fourth.taskId}/verify-youtube-subscription`, userToken, {});
  const after = stub.requestLog.filter((r: string) => r === 'POST /token').length;
  check('a refresh call was actually made', after > before, { before, after });
  check('verification continues after refresh', refreshed.body?.data?.verified === true, refreshed.body?.data);
  const reconnected = await prisma.googleAccountConnection.findUniqueOrThrow({ where: { userId: user.id } });
  check('new expiry stored', (reconnected.tokenExpiry?.getTime() ?? 0) > Date.now(), reconnected.tokenExpiry);
  check('status stays CONNECTED', reconnected.status === 'CONNECTED', reconnected.status);

  // --- Scenario 7: authorization revoked at Google -----------------------
  console.log('\nScenario 7 - Google authorization revoked');
  for (const entry of stub.refreshTokens.values()) {
    if (entry.googleAccountId === USER_GOOGLE_ID) entry.revoked = true;
  }
  await prisma.googleAccountConnection.update({ where: { userId: user.id }, data: { tokenExpiry: new Date(Date.now() - 60_000) } });
  const fifth = await createLiveCampaign(agentToken, 'Revoked Grant Campaign');
  await call('POST', `/tasks/${fifth.taskId}/start`, userToken, {});
  const revoked = await call('POST', `/tasks/${fifth.taskId}/verify-youtube-subscription`, userToken, {});
  check('verification reports reconnect required', revoked.body?.error?.code === 'GOOGLE_REAUTH_REQUIRED', revoked.body?.error);
  const revokedRow = await prisma.googleAccountConnection.findUniqueOrThrow({ where: { userId: user.id } });
  check('connection marked REAUTH_REQUIRED', revokedRow.status === 'REAUTH_REQUIRED', revokedRow.status);
  const revokedView = await call('GET', '/google-oauth/user/connection', userToken);
  check('UI is told to reconnect', revokedView.body?.data?.google?.reconnectRequired === true, revokedView.body?.data?.google);

  // --- Starting a task with a stale grant --------------------------------
  // The gate the Ionic app renders before Start Task reads these two codes to
  // decide between "connect an account" and "reconnect the one you have", so
  // they have to stay distinguishable.
  console.log('\nTask gate - starting with an expired grant vs. no account at all');
  const sixth = await createLiveCampaign(agentToken, 'Stale Grant Start Campaign');
  const staleStart = await call('POST', `/tasks/${sixth.taskId}/start`, userToken, {});
  check('start refused while the grant is stale', staleStart.status === 409, staleStart.body);
  check('reported as reconnect, not as missing', staleStart.body?.error?.code === 'GOOGLE_REAUTH_REQUIRED', staleStart.body?.error);

  // --- Disconnect --------------------------------------------------------
  console.log('\nDisconnect - credentials removed');
  const disconnected = await call('DELETE', '/google-oauth/user/connection', userToken);
  check('disconnect succeeds', disconnected.status === 200, disconnected.body);
  const gone = await prisma.googleAccountConnection.findUnique({ where: { userId: user.id } });
  check('stored credentials deleted', gone === null);

  const afterDisconnect = await call('POST', `/tasks/${sixth.taskId}/start`, userToken, {});
  check('start now reports a missing account', afterDisconnect.body?.error?.code === 'GOOGLE_ACCOUNT_NOT_CONNECTED', afterDisconnect.body?.error);

  // A leftover googleId on the account (from the removed Google Sign-In
  // flow) must not be mistaken for a YouTube authorization. Nothing writes
  // that column any more, but rows that already carry one still exist, and
  // the gate has to treat them exactly like anyone else.
  console.log('\nLeftover googleId - not a YouTube authorization');
  await prisma.user.update({ where: { id: user.id }, data: { googleId: 'legacy-sso-sub', emailVerified: true } });
  const legacyStart = await call('POST', `/tasks/${sixth.taskId}/start`, userToken, {});
  check('a googleId on the account does not skip the connect step', legacyStart.body?.error?.code === 'GOOGLE_ACCOUNT_NOT_CONNECTED', legacyStart.body?.error);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log('Failing checks:\n  - ' + failures.join('\n  - '));
}

main()
  .catch((err) => {
    console.error('\nHARNESS ERROR:', err);
    failed += 1;
  })
  .finally(async () => {
    api?.kill();
    await stopStub().catch(() => {});
    // Fixtures are removed on the way out so the suite can be re-run against
    // the same database, and so a development environment is not left holding
    // test users, campaigns and wallet rows. Deleting the two users cascades
    // to their agent profile, campaigns, tasks, completions, wallet
    // transactions and Google connections.
    await prisma.user
      .deleteMany({ where: { email: { in: ['yt-agent@test.local', 'yt-user@test.local'] } } })
      .catch(() => {});
    if (previousRewardAmount !== null) {
      await prisma.campaignType
        .update({ where: { code: 'YOUTUBE_SUBSCRIBE' }, data: { rewardAmount: previousRewardAmount as never } })
        .catch(() => {});
    }
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });

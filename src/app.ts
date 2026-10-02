import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { checkDatabase, poolStats } from './db/prisma.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { agentsRouter } from './modules/agents/agents.routes.js';
import { subscriptionsRouter } from './modules/subscriptions/subscriptions.routes.js';
import { campaignsRouter } from './modules/campaigns/campaigns.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { campaignFeedRouter } from './modules/campaign-feed/campaign-feed.routes.js';
import { taskCompletionsRouter, tasksRouter } from './modules/tasks/tasks.routes.js';
import { paymentsRouter } from './modules/payments/payments.routes.js';
import { withdrawalsRouter } from './modules/withdrawals/withdrawals.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { platformSettingsRouter } from './modules/platform-settings/platform-settings.routes.js';
import { referralsRouter } from './modules/referrals/referrals.routes.js';
import { referralLandingHandler } from './modules/referrals/referral-landing.controller.js';
import { cmsRouter } from './modules/cms/cms.routes.js';
import { supportRouter } from './modules/support/support.routes.js';
import { adsRouter } from './modules/ads/ads.routes.js';
import { gamesRouter } from './modules/games/games.routes.js';
import { gameRewardsRouter } from './modules/games/game-rewards.routes.js';
import { appVerificationRouter } from './modules/app-verification/app-verification.routes.js';
import { websiteVerificationRouter } from './modules/website-verification/website-verification.routes.js';
import { googleOAuthRouter } from './modules/google-oauth/google-oauth.routes.js';
import { translationRouter } from './modules/translation/translation.routes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export const app = express();

// Behind nginx or a load balancer the socket's remote address is the proxy,
// not the caller, so without this every request looks like it comes from one
// IP - which makes per-IP rate limiting throttle the entire user base as a
// single client. Configured rather than hardcoded because trusting a
// forwarded header with no proxy in front lets any caller spoof its address.
if (env.trustProxy) {
  const hops = Number(env.trustProxy);
  app.set('trust proxy', Number.isFinite(hops) ? hops : env.trustProxy);
}

app.use(
  helmet({
    // Helmet's default is same-origin, which blocks any other domain from
    // loading images or other resources served by this API. Relaxed
    // globally to match the open CORS policy below, so a page hosted
    // anywhere can render campaign artwork and payment proofs.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

// Open to every domain, by choice. env.corsOrigins is still parsed and is
// what to switch back to if this ever needs narrowing (see config/env.ts).
//
// origin: true reflects whatever Origin the caller sent, rather than
// answering with a literal "*". The distinction matters: browsers refuse a
// wildcard origin on any request that carries credentials, and this API
// uses cookies, so a literal "*" would break exactly the authenticated
// cross-domain calls it is meant to allow. Reflecting the origin permits
// every domain and keeps credentials working.
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    // Lets browsers read the rate-limit headers the limiters send, which are
    // otherwise hidden from cross-origin JavaScript.
    exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
    // Caches the preflight for a day. Without it a browser sends an extra
    // OPTIONS round trip before nearly every cross-origin call, which on a
    // mobile connection doubles the latency of each one.
    maxAge: 86_400,
    optionsSuccessStatus: 204,
  }),
);

// gzip before anything writes a body. JSON list responses (the campaign
// feed, the admin tables) are highly repetitive and typically compress to a
// fraction of their size, which on a phone connection is most of what
// "responds quickly" actually means. Responses under the threshold are left
// alone, since compressing a few hundred bytes costs more than it saves.
if (env.compressionEnabled) {
  app.use(compression({ threshold: env.compressionThreshold }));
}

app.use(cookieParser());
// An explicit ceiling on buffered request bodies, so an oversized POST is
// rejected up front instead of being read into memory. Uploads do not pass
// through here - multer streams those straight to disk.
app.use(express.json({ limit: env.jsonBodyLimit }));
app.use(express.urlencoded({ extended: false, limit: env.jsonBodyLimit }));

// Health checks are polled constantly by load balancers and uptime monitors;
// logging every one buries real traffic and costs a write per probe.
if (env.httpLogEnabled) {
  app.use(morgan(env.httpLogFormat, { skip: (req) => req.url === '/health' || req.url.startsWith('/health/') }));
}

// Two tiers, because they defend against different things. The auth limiter
// is the strict one - those routes are where password and OTP guessing
// happens. The API limiter is a wide backstop that only catches a client
// stuck in a retry loop; it is deliberately far above what a real user can
// generate, since everyone behind one office or mobile-carrier NAT is
// counted as a single IP.
//
// Both use the in-process memory store, so with CLUSTER_WORKERS > 1 each
// worker keeps its own tally and the effective ceiling is (limit x workers).
// Moving to a shared Redis store is the fix if these ever need to be exact.
const limiterMessage = (message: string) => ({ success: false, error: { code: 'RATE_LIMITED', message } });

const authLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.rateLimitAuthMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !env.rateLimitEnabled,
  message: limiterMessage('Too many attempts. Try again later.'),
});

const apiLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.rateLimitApiMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !env.rateLimitEnabled,
  message: limiterMessage('Too many requests. Please slow down and try again shortly.'),
});

// Deliberately does not touch the database: this is what a load balancer
// polls to decide whether the process is alive, and making it depend on
// PostgreSQL turns one slow query into every instance being pulled out of
// rotation at once.
app.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

// Readiness, as opposed to liveness - answers "can this process actually
// serve traffic right now", and reports pool saturation, which is the first
// thing worth looking at when the API feels slow under load.
app.get('/health/db', async (_req, res) => {
  const ok = await checkDatabase();
  res.status(ok ? 200 : 503).json({
    success: ok,
    data: {
      status: ok ? 'ok' : 'unavailable',
      database: ok ? 'up' : 'down',
      pool: poolStats(),
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  });
});

// Read-only static file serving for payment-proof screenshots and platform
// QR images (Phase 7) - express.static never executes anything it serves,
// and every filename under here was generated server-side (see
// middleware/upload.ts), never taken from client input. Helmet's default
// Cross-Origin-Resource-Policy: same-origin would otherwise block the
// Angular admin panel (a different origin/port) from rendering these images
// in <img> tags, so it's relaxed to cross-origin for this path only.
app.use('/uploads', (_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(process.cwd(), 'uploads'), {
  // Every filename here is a fresh UUID assigned at upload time and the file
  // is never rewritten, so the bytes behind a given URL can never change.
  // That makes these safely immutable: browsers stop re-requesting them
  // entirely, which removes the bulk of the repeat traffic this server sees.
  maxAge: '30d',
  immutable: true,
  etag: true,
  lastModified: true,
}));

// Checked-in branding assets (currently just the og:image the referral
// landing page points at - see referral-landing.controller.ts) rather than
// runtime uploads, so this is served straight from the repo, not /uploads.
// Needs the same cross-origin relaxation: WhatsApp/Facebook/etc. fetch this
// from their own crawler infrastructure to build the link preview, which is
// itself a cross-origin request.
app.use('/assets', (_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(process.cwd(), 'public'), {
  maxAge: '7d',
  etag: true,
  lastModified: true,
}));

// Mounted before the routers so it covers every /api route, including any
// added later that would otherwise ship with no limit at all.
app.use('/api', apiLimiter);

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/users', usersRouter);
app.use('/api/campaign-feed', campaignFeedRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/task-completions', taskCompletionsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/withdrawals', withdrawalsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/platform-settings', platformSettingsRouter);
app.use('/api/referrals', referralsRouter);
app.use('/api/cms', cmsRouter);
app.use('/api/support', supportRouter);
app.use('/api/ads', adsRouter);
app.use('/api/games', gamesRouter);
app.use('/api/game-rewards', gameRewardsRouter);
app.use('/api/app-verification', appVerificationRouter);
app.use('/api/website-verification', websiteVerificationRouter);
app.use('/api/google-oauth', googleOAuthRouter);
app.use('/api/translate', translationRouter);

// Lightweight, dependency-free referral landing page (spec Phase 9 §4/§17) -
// intentionally NOT part of the Ionic Angular bundle; served directly by
// this backend so an anonymous visitor never downloads the whole app just
// to see an invite. Shares the same rate limiter used for the JSON
// validate-code endpoint since it performs the same lookup+click-count work.
const referralLandingLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.rateLimitReferralMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !env.rateLimitEnabled,
  message: limiterMessage('Too many requests. Try again later.'),
});
app.get('/referral/:code', referralLandingLimiter, referralLandingHandler);

app.use(notFoundHandler);
app.use(errorHandler);

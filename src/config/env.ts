import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4227),
  databaseUrl: required('DATABASE_URL'),
  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  // Access-token lifetime. Deliberately long: this API's clients are a
  // mobile app and two Angular panels that keep someone signed in for days
  // at a time, and a short access token only pays for itself when every
  // client reliably performs a silent refresh. Shorten it here (or through
  // JWT_ACCESS_EXPIRES_IN) once that refresh path is proven end to end.
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '7d',
  // Drives BOTH the documented refresh lifetime and the expiresAt actually
  // written to the refresh_tokens table - see utils/refreshToken.ts, which
  // used to hardcode 30 days and ignore this value entirely.
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '90d',
  // 4300 = angular-agent-admin's dev port; 4200 = angular-landing-page's
  // default Angular CLI dev port (it has no custom port configured). The
  // landing page needs this now that it fetches the public subscription
  // plan catalog directly from the browser.
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:4300,http://localhost:4200').split(',').map((s) => s.trim()),

  // Same account-wide key Fast2SMS issues for all of its products - now used
  // to authorize calls to its WhatsApp OTP API instead of the old SMS
  // bulkV2 route.
  fast2smsApiKey: process.env.FAST2SMS_API_KEY ?? '',
  // Identifies the pre-approved "otp_verification" WhatsApp template
  // (category: Authentication, body "{{1}} is your verification code...").
  // This is Fast2SMS's own internal id for that message config - shown as
  // "Message ID" on its WhatsApp template dashboard - not Meta's template id.
  fast2smsWhatsappMessageId: process.env.FAST2SMS_WHATSAPP_MESSAGE_ID ?? '',
  // Identifies which WhatsApp Business sender the template is sent from.
  // Shown on the same dashboard; not the sender's phone number itself.
  fast2smsWhatsappPhoneNumberId: process.env.FAST2SMS_WHATSAPP_PHONE_NUMBER_ID ?? '',
  otpLength: Number(process.env.OTP_LENGTH ?? 4),
  otpExpiryMinutes: Number(process.env.OTP_EXPIRY_MINUTES ?? 5),
  otpResendCooldownSeconds: Number(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? 120),
  otpMaxAttempts: Number(process.env.OTP_MAX_ATTEMPTS ?? 5),
  otpVerificationValidityMinutes: Number(process.env.OTP_VERIFICATION_VALIDITY_MINUTES ?? 15),

  // Referral links/landing pages (Phase 9) - never hardcode a domain in
  // source (spec §21); publicWebUrl is where this backend itself is
  // reachable (it serves the lightweight referral landing page), ionicAppUrl
  // is where the actual Ionic web build is hosted (the landing page's
  // "Get Started" CTA target) - in production this becomes an app-store /
  // App Link URL instead, without any code change here.
  publicWebUrl: process.env.PUBLIC_WEB_URL ?? 'http://localhost:4227',
  ionicAppUrl: process.env.IONIC_APP_URL ?? 'http://localhost:8100',
  // Where the Angular Agent/Admin panel itself is hosted - the base for the
  // account-verification email's link (.../auth/verify-email?token=...).
  // Defaults to its local `ng serve` port (angular.json), never hardcoded
  // for production.
  agentAdminUrl: process.env.AGENT_ADMIN_URL ?? 'http://localhost:4300',

  // SMTP transport for transactional email (agent registration verification
  // today; reusable for any future email). Left unset in dev/test - see
  // services/email.service.ts's dev-only escape hatch, which mirrors
  // whatsapp.service.ts's own "no key configured -> log instead of failing"
  // pattern exactly. Real credentials are provided later, never hardcoded.
  smtpHost: process.env.SMTP_HOST ?? '',
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  // true only for port 465 (implicit TLS); 587/25 use STARTTLS instead, which
  // nodemailer negotiates itself when secure is false.
  smtpSecure: (process.env.SMTP_SECURE ?? '') === 'true' || Number(process.env.SMTP_PORT ?? 587) === 465,
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPass: process.env.SMTP_PASS ?? '',
  smtpFromEmail: process.env.SMTP_FROM_EMAIL ?? 'no-reply@earnivo.app',
  smtpFromName: process.env.SMTP_FROM_NAME ?? 'Earnivo',

  // The OAuth client ID. Not a secret - only the client SECRET below is.
  // Sign-in with Google was removed (users authenticate by phone + OTP), so
  // this is now used solely by the YouTube Subscribe authorization-code flow
  // in modules/google-oauth.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',

  // Google OAuth 2.0 authorization-code flow (YouTube Subscribe
  // verification). The exchange yields real access/refresh tokens, so it
  // needs the client SECRET - which is exactly why the whole exchange lives
  // here on the backend and never in Angular or Ionic.
  //
  // googleRedirectUri is the ONE redirect URI registered in the Google Cloud
  // console. Both roles come back through it; which owner a callback belongs
  // to is carried by the signed `state` parameter, not by a separate URI per
  // role (see google-oauth.service.ts). The two *_REDIRECT_URI values below
  // are where the browser is sent AFTER the callback has stored the tokens -
  // a landing page, not an OAuth endpoint - and are never sent to Google.
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ?? `${process.env.PUBLIC_WEB_URL ?? 'http://localhost:4227'}/api/google-oauth/callback`,
  // Agent panel lands back on its own YouTube Account screen. The Ionic user
  // app has no URL to return to inside a Capacitor WebView, so it defaults to
  // a backend-served "you can close this window" page instead - the app just
  // re-reads its connection status once the in-app browser closes.
  googleAgentRedirectUri: process.env.GOOGLE_AGENT_REDIRECT_URI ?? `${process.env.AGENT_ADMIN_URL ?? 'http://localhost:4300'}/agent/settings/youtube`,
  googleUserRedirectUri: process.env.GOOGLE_USER_REDIRECT_URI ?? '',
  // How long a signed OAuth `state` stays valid - long enough for a real
  // consent screen (including picking an account and reading the scopes),
  // short enough that a state captured from a browser history cannot be
  // replayed later.
  googleOauthStateTtlSeconds: Number(process.env.GOOGLE_OAUTH_STATE_TTL_SECONDS ?? 600),
  // Outbound ceiling for Google/YouTube API calls, same reasoning as
  // whatsappTimeoutMs: these run inside a request a user is waiting on, and
  // fetch has no timeout of its own.
  googleApiTimeoutMs: Number(process.env.GOOGLE_API_TIMEOUT_MS ?? 10_000),
  // The four Google/YouTube endpoints this feature talks to, overridable
  // only so the flow can be pointed at a local test double (or an outbound
  // proxy) and exercised end to end - real token exchange, real refresh,
  // real error mapping - without Google credentials. Nothing in the request
  // path branches on these: the code makes the same calls either way, which
  // is the entire point of overriding the address rather than adding a
  // "pretend it worked" bypass. Never set these in production.
  googleAuthEndpoint: process.env.GOOGLE_OAUTH_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
  googleTokenEndpoint: process.env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
  googleRevokeEndpoint: process.env.GOOGLE_OAUTH_REVOKE_URL ?? 'https://oauth2.googleapis.com/revoke',
  youtubeApiBaseUrl: process.env.YOUTUBE_API_BASE_URL ?? 'https://www.googleapis.com/youtube/v3',

  // Symmetric key for the OAuth tokens stored in google_account_connections
  // (utils/crypto.ts, AES-256-GCM). Any non-empty string works - it is
  // stretched to 32 bytes with SHA-256 - but it must be stable: rotating it
  // makes every stored token undecryptable, which surfaces as every
  // connected account being asked to reconnect. Falls back to the JWT access
  // secret so a development environment is never left storing plaintext
  // tokens just because one more variable was missing.
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY ?? '',

  // Firebase Cloud Messaging (push notifications). These come from a
  // Firebase SERVICE ACCOUNT key, which is a different artifact from the
  // android/app/google-services.json the Ionic app ships: that file only
  // tells the *device* which Firebase project to register with, and carries
  // no authority to send anything. Only a service account can call the FCM
  // send API, so the two are not interchangeable.
  //
  // Left blank by default on purpose. push.service.ts then logs the payload
  // and returns instead of throwing - the same "no credentials configured ->
  // log rather than fail" escape hatch whatsapp.service.ts and
  // email.service.ts already use, so local development and tests never need
  // a real key and a withdrawal approval never 500s just because push is
  // unconfigured.
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? '',
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? '',
  // Stored in .env as a single line with literal \n escapes (a PEM's real
  // newlines cannot survive dotenv), so they are turned back into real
  // newlines here rather than at each use.
  firebasePrivateKey: (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
  // Same reasoning as whatsappTimeoutMs: a push send happens inside a request
  // that a user is waiting on, and fetch has no timeout of its own.
  pushTimeoutMs: Number(process.env.PUSH_TIMEOUT_MS ?? 10_000),
  // How many FCM sends run concurrently during a broadcast. FCM's HTTP v1
  // API is strictly one device token per request, so a platform-wide
  // announcement is N requests; this bounds how many are in flight at once
  // so a broadcast cannot exhaust the server's sockets.
  pushConcurrency: Number(process.env.PUSH_CONCURRENCY ?? 20),

  // ---------------------------------------------------------------------
  // Runtime tuning. Everything below exists so a busy server degrades
  // predictably instead of falling over, and so each ceiling is an env knob
  // rather than a literal buried somewhere in the request path.
  // ---------------------------------------------------------------------

  // Node executes JavaScript on a single thread, so one process can only
  // ever saturate one CPU core no matter how many requests arrive at once.
  // Forking a worker per core is what turns concurrent requests into
  // genuinely parallel work. 0 means "one per core"; 1 disables clustering.
  clusterWorkers: Number(process.env.CLUSTER_WORKERS ?? 1),

  // Set to the number of proxy hops (usually 1) when nginx or a load
  // balancer sits in front, so req.ip is the real client and per-IP rate
  // limiting stops treating the whole internet as one address. Off by
  // default: trusting a forwarded header with no proxy present lets any
  // caller spoof its own IP and walk straight through the limiter.
  trustProxy: process.env.TRUST_PROXY ?? '',

  // PostgreSQL connection pool. Every in-flight query holds one connection,
  // so this is the real ceiling on database concurrency - past it requests
  // queue rather than fail. Keep (dbPoolMax x clusterWorkers) comfortably
  // under PostgreSQL's own max_connections, which defaults to 100.
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 20),
  dbPoolMin: Number(process.env.DB_POOL_MIN ?? 0),
  dbPoolIdleTimeoutMs: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? 30_000),
  // How long a request waits for a free pooled connection before giving up.
  // Without it a stalled pool turns into requests that hang forever.
  dbConnectionTimeoutMs: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 10_000),
  // Server-side cap on any single statement, enforced by PostgreSQL itself.
  // One pathological query can otherwise pin a pooled connection
  // indefinitely and starve every other caller.
  dbStatementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 15_000),

  // Must stay above the idle timeout of anything in front of this server
  // (an AWS load balancer defaults to 60s), otherwise the proxy reuses a
  // socket Node has already started closing and the client sees a 502.
  httpKeepAliveTimeoutMs: Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS ?? 65_000),
  // Node requires this to exceed keepAliveTimeout or the two race.
  httpHeadersTimeoutMs: Number(process.env.HTTP_HEADERS_TIMEOUT_MS ?? 70_000),
  // Hard ceiling on one request start to finish. Generous enough for a 5MB
  // image upload over a slow phone connection, short enough that a hung
  // client eventually releases its socket.
  httpRequestTimeoutMs: Number(process.env.HTTP_REQUEST_TIMEOUT_MS ?? 120_000),
  // Grace period for in-flight requests to finish during shutdown before
  // the process is killed anyway.
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 15_000),

  // Rate limiting. The auth limiter is the strict one because those routes
  // are the brute-force target; the API limiter is a wide backstop meant to
  // stop a runaway client, not to throttle normal use. Both count per IP,
  // so everyone behind one office or mobile-carrier NAT shares a budget -
  // which is why these are generous rather than tight.
  rateLimitEnabled: (process.env.RATE_LIMIT_ENABLED ?? 'true') === 'true',
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000),
  rateLimitAuthMax: Number(process.env.RATE_LIMIT_AUTH_MAX ?? 100),
  rateLimitApiMax: Number(process.env.RATE_LIMIT_API_MAX ?? 1_000),
  rateLimitReferralMax: Number(process.env.RATE_LIMIT_REFERRAL_MAX ?? 120),

  // Caps the JSON body express will buffer, so a large POST cannot be used
  // to soak up memory. Naming it here makes the limit visible and tunable
  // instead of an invisible framework default.
  jsonBodyLimit: process.env.JSON_BODY_LIMIT ?? '256kb',

  // bcrypt work factor. Hashing is deliberately slow and runs on libuv's
  // thread pool, so under concurrent logins this is the single most
  // expensive thing the server does. 10 rounds stays well above the
  // practical brute-force threshold while costing roughly a quarter of 12.
  // Existing hashes keep verifying: the cost is stored inside each hash.
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 10),

  // gzip for JSON responses. The feed and admin list endpoints compress to
  // a fraction of their size, which is most of the perceived speed gain on
  // a mobile connection.
  compressionEnabled: (process.env.COMPRESSION_ENABLED ?? 'true') === 'true',
  compressionThreshold: Number(process.env.COMPRESSION_THRESHOLD ?? 1_024),

  // Outbound call ceilings. Without them a hung third party holds an
  // inbound request open indefinitely, which is how one slow provider takes
  // the whole server down with it.
  whatsappTimeoutMs: Number(process.env.WHATSAPP_TIMEOUT_MS ?? 10_000),
  smtpTimeoutMs: Number(process.env.SMTP_TIMEOUT_MS ?? 10_000),

  // Request logging. Morgan writes a line per request, which is real
  // overhead on a hot path, so production uses the compact format and
  // health checks are skipped entirely (see app.ts).
  httpLogEnabled: (process.env.HTTP_LOG_ENABLED ?? 'true') === 'true',
  httpLogFormat:
    process.env.HTTP_LOG_FORMAT ?? ((process.env.NODE_ENV ?? 'development') === 'production' ? 'combined' : 'dev'),
};

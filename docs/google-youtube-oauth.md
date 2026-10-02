# Google OAuth & YouTube API access

Everything needed to turn on YouTube Subscribe verification: which credentials
Google issues, how to get them, and the three rules that will otherwise cost
you an afternoon.

## What you are actually getting

Three values, and only two of them come from Google:

| Value | Where it comes from | Secret? |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google Cloud Console | No — the same ID ships in clients |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console | **Yes** — backend only, never in Angular or Ionic |
| `TOKEN_ENCRYPTION_KEY` | You generate it | **Yes** — encrypts stored tokens at rest |

There is no such thing as a permanent "access key" for this feature. Access
and refresh tokens are issued *per user, per agent*, at the moment they press
Connect, and Earnivo stores them encrypted in `google_account_connections`.
The client ID and secret are only what lets the backend ask Google for them.

`GOOGLE_CLIENT_ID` here is the **same OAuth client** already used for Google
Sign-In. You are adding a secret and a redirect URI to it, not creating a
second one.

## One-time setup

### 1. Enable the YouTube Data API

> [Google Cloud Console](https://console.cloud.google.com/) → pick your project →
> **APIs & Services → Library** → search **YouTube Data API v3** → **Enable**

Without this the OAuth flow still completes and then every verification fails
with a 403, which reads like a permissions bug rather than a missing API.

### 2. Configure the OAuth consent screen

> **APIs & Services → OAuth consent screen**

- **User type: External** (unless every user has a Google Workspace account in
  your org, which they do not — these are public app users).
- Fill in app name, support email, developer contact. These are shown on the
  consent screen your users will read.
- Under **Scopes**, add:

  ```
  https://www.googleapis.com/auth/youtube.readonly
  ```

  `openid` and `email` are added automatically and need no action.

Google classifies `youtube.readonly` as a **sensitive** scope. That has real
consequences — see [Publishing status](#publishing-status-the-7-day-trap)
below, which is the single most important section in this file.

### 3. Create the OAuth client

> **APIs & Services → Credentials → Create credentials → OAuth client ID**
> → Application type: **Web application**

**Web application**, not Android — even for the Ionic app. The phone never
talks to Google directly: it opens the system browser, and Google redirects
back to *the backend*, which does the code exchange. That makes this a
server-side flow regardless of which client started it.

Under **Authorized redirect URIs**, add the backend callback:

```
https://api.your-domain.com/api/google-oauth/callback
```

Then copy the **Client ID** and **Client secret** it shows you. The secret is
displayed once; if you lose it, generate a new one rather than guessing.

### 4. Redirect URIs must match exactly — and must be HTTPS

Google compares the redirect URI character for character. Scheme, host, port,
path, trailing slash. `http://x/cb` and `https://x/cb/` are three different
mismatches.

**Google only accepts `http://` for `localhost` and `127.0.0.1`.** A LAN
address like `http://10.166.10.35:4227/...` — which is what
`angular-ionic/src/environments/environment.ts` currently points at so a
physical phone can reach your machine — **will be rejected by the console.**

So for development you have two options:

- **Testing in a desktop browser** (agent panel, or `ionic serve`): use
  `http://localhost:4227/api/google-oauth/callback`. Allowed, no tunnel needed.
- **Testing on a physical phone**: put an HTTPS tunnel in front of the backend
  and register the tunnel's URL:

  ```
  npx cloudflared tunnel --url http://localhost:4227
  # or: ngrok http 4227
  ```

  Register `https://<tunnel-host>/api/google-oauth/callback` as a redirect URI
  and set `GOOGLE_REDIRECT_URI` to the same string. The tunnel host changes
  each restart on free tiers, so expect to update both together.

You can register several redirect URIs on one client, so localhost, your
tunnel and production can all coexist.

### 5. Add test users

> **OAuth consent screen → Test users → Add users**

While the app's publishing status is *Testing*, only listed accounts can get
through consent — up to 100. Everyone else sees `access_denied`, which looks
like a code failure and is not one. Add every Google account you plan to test
with, **including the agent account whose channel you will target and the user
account that will subscribe.**

### 6. Fill in `nodejs/.env`

```bash
GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
GOOGLE_REDIRECT_URI=https://api.your-domain.com/api/google-oauth/callback
TOKEN_ENCRYPTION_KEY=<a long random string, see below>
```

Generate the encryption key yourself — it is not a Google value:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

It must stay **stable**. Rotating it makes every stored token undecryptable,
which surfaces as every connected account suddenly being asked to reconnect.
Leaving it blank is safe but not ideal: `utils/crypto.ts` falls back to
`JWT_ACCESS_SECRET` so tokens are still encrypted, never stored in plaintext.

Leaving `GOOGLE_CLIENT_SECRET` blank is also supported — the connect endpoints
answer `GOOGLE_OAUTH_NOT_CONFIGURED` and the rest of the platform is unaffected.

Restart the backend after editing `.env`.

## Publishing status: the 7-day trap

This is the one that bites silently.

**While your app's publishing status is *Testing*, refresh tokens issued for
sensitive scopes expire after 7 days.** Everything works perfectly for a week,
then every connected account starts failing with `GOOGLE_REAUTH_REQUIRED` and
users are asked to reconnect — with no code change to blame it on.

Earnivo handles this correctly (the connection flips to `REAUTH_REQUIRED` and
both UIs offer a Reconnect button), so nothing breaks. But you should know it
is Google's policy and not a bug, and that it disappears once the app is
published.

To remove the limit, move the consent screen to **In production**. Because
`youtube.readonly` is sensitive, that means submitting for **verification**:

- A privacy policy URL and a homepage on a domain you have verified in
  [Search Console](https://search.google.com/search-console)
- A demo video showing the consent screen and what the scope is used for
- A written justification — for this app: *"to confirm that a user who was
  rewarded for subscribing to a channel is genuinely subscribed to it"*

Review typically takes a few days to a few weeks. Start it before you need it.
Until it clears, you are limited to 100 test users and weekly reconnections.

## Quota

The YouTube Data API gives a project **10,000 units per day** by default.
Everything this feature calls costs **1 unit**:

| Call | When | Cost |
| --- | --- | --- |
| `channels.list` | Agent connects or refreshes their channel | 1 |
| `subscriptions.list` | Each *Verify Subscription* tap | 1 |

So roughly 10,000 verification attempts per day. That is also exactly why
verification is a button rather than a polling loop: continuous polling would
burn the whole day's allowance on a handful of users. If you outgrow it,
request more in **APIs & Services → YouTube Data API v3 → Quotas**.

Quota exhaustion is reported as `YOUTUBE_QUOTA_EXCEEDED` and deliberately does
**not** tell users to reconnect — their account is fine, the platform is not.

## Checking it works

1. Sign in to the agent panel → **Settings → YouTube Account** → *Connect
   Google / YouTube Account*. You should land back on that page with your
   channel name, thumbnail and channel ID filled in.
2. Create a **YouTube Subscribe (Verified)** campaign. The target channel is
   shown read-only — it comes from the connection, not a text box.
3. In the Ionic app: **Profile → YouTube Verification Account**, or just open
   the campaign — the task shows a Connect card before Start Task.
4. Subscribe on YouTube **using the same Google account**, come back, tap
   *Verify Subscription*.

To exercise all of this without Google credentials at all, run the scenario
suite, which points the same code paths at a local stub:

```bash
cd nodejs && npm test
```

## When something fails

| Symptom | Cause |
| --- | --- |
| `redirect_uri_mismatch` | The registered URI and `GOOGLE_REDIRECT_URI` differ. Compare them character by character, including port and trailing slash. |
| Console refuses to save the redirect URI | It is `http://` on something other than `localhost`/`127.0.0.1`. Use a tunnel — see step 4. |
| `access_denied` right after choosing an account | That Google account is not in **Test users**, and the app is still in Testing. |
| Connect succeeds, verification 403s | **YouTube Data API v3** was never enabled on the project (step 1). |
| `NO_YOUTUBE_CHANNEL` when an agent connects | That Google account has no YouTube channel. Connect the account that owns the channel — a Brand Account channel must be selected on the consent screen's account picker. |
| Everyone asked to reconnect after a week | Expected while in Testing. See [the 7-day trap](#publishing-status-the-7-day-trap). |
| Everyone asked to reconnect immediately | `TOKEN_ENCRYPTION_KEY` changed. Stored tokens can no longer be decrypted. |
| `GOOGLE_OAUTH_NOT_CONFIGURED` | `GOOGLE_CLIENT_SECRET` is blank, or the backend was not restarted after editing `.env`. |

## What is *not* needed here

Native Google **Sign-In** on Android is a separate, unfinished piece of work.
It needs an extra **Android** OAuth client, your app's SHA-1 signing
certificate, and a Capacitor plugin. None of that is required for YouTube
verification — that flow works on device today through the system browser.
See `angular-ionic/src/app/core/auth/google-identity.service.ts`.

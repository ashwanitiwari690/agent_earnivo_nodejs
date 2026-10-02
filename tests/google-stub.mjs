// A stand-in for Google's OAuth token endpoint and the YouTube Data API,
// used only to run the YouTube Subscribe scenarios end to end without real
// credentials. The Earnivo backend is pointed at this by the four
// GOOGLE_OAUTH_*_URL / YOUTUBE_API_BASE_URL env vars and makes exactly the
// same HTTP calls it would make against Google.
import http from 'node:http';

// Mutable so a test can revoke a grant, expire a token, or change who is
// subscribed to what between requests.
export const state = {
  // authorization code -> the identity and grant it exchanges into
  codes: new Map(),
  // refresh token -> { accessToken, revoked }
  refreshTokens: new Map(),
  // access token -> googleAccountId
  accessTokens: new Map(),
  // googleAccountId -> { channel, subscriptions:Set<channelId> }
  accounts: new Map(),
  // Access tokens minted from here expire this many seconds out.
  accessTokenTtlSeconds: 3600,
  requestLog: [],
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function mintAccessToken(googleAccountId) {
  const token = `at_${googleAccountId}_${Math.random().toString(36).slice(2, 10)}`;
  state.accessTokens.set(token, googleAccountId);
  return token;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  state.requestLog.push(`${req.method} ${url.pathname}`);

  // --- token endpoint: authorization_code + refresh_token grants ---
  if (url.pathname === '/token' && req.method === 'POST') {
    const body = await readBody(req);
    const grantType = body.get('grant_type');

    if (grantType === 'authorization_code') {
      const entry = state.codes.get(body.get('code'));
      if (!entry) return json(res, 400, { error: 'invalid_grant' });
      state.codes.delete(body.get('code'));

      const accessToken = mintAccessToken(entry.googleAccountId);
      const refreshToken = entry.refreshToken ?? `rt_${entry.googleAccountId}`;
      state.refreshTokens.set(refreshToken, { googleAccountId: entry.googleAccountId, revoked: false });

      return json(res, 200, {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: entry.expiresIn ?? state.accessTokenTtlSeconds,
        scope: entry.scope ?? 'openid email https://www.googleapis.com/auth/youtube.readonly',
        // Only the payload segment is ever read (it came from the token
        // endpoint over TLS in the real flow), so header/signature are filler.
        id_token: `x.${base64url({ sub: entry.googleAccountId, email: entry.email })}.y`,
      });
    }

    if (grantType === 'refresh_token') {
      const entry = state.refreshTokens.get(body.get('refresh_token'));
      // What a revoked grant actually looks like from Google.
      if (!entry || entry.revoked) return json(res, 400, { error: 'invalid_grant' });
      return json(res, 200, {
        access_token: mintAccessToken(entry.googleAccountId),
        expires_in: state.accessTokenTtlSeconds,
        scope: 'openid email https://www.googleapis.com/auth/youtube.readonly',
      });
    }

    return json(res, 400, { error: 'unsupported_grant_type' });
  }

  if (url.pathname === '/revoke' && req.method === 'POST') {
    const body = await readBody(req);
    const token = body.get('token');
    const entry = state.refreshTokens.get(token);
    if (entry) entry.revoked = true;
    return json(res, 200, {});
  }

  // --- YouTube Data API ---
  const bearer = (req.headers.authorization ?? '').replace('Bearer ', '');
  const googleAccountId = state.accessTokens.get(bearer);

  if (url.pathname.startsWith('/youtube/')) {
    if (!googleAccountId) {
      return json(res, 401, { error: { code: 401, errors: [{ reason: 'authError' }] } });
    }
    const account = state.accounts.get(googleAccountId) ?? { subscriptions: new Set() };

    if (url.pathname === '/youtube/channels') {
      if (!account.channel) return json(res, 200, { items: [] });
      return json(res, 200, {
        items: [
          {
            id: account.channel.id,
            snippet: {
              title: account.channel.title,
              customUrl: account.channel.customUrl,
              thumbnails: { high: { url: account.channel.thumbnailUrl } },
            },
          },
        ],
      });
    }

    if (url.pathname === '/youtube/subscriptions') {
      const forChannelId = url.searchParams.get('forChannelId');
      const subscribed = account.subscriptions?.has(forChannelId);
      return json(res, 200, {
        items: subscribed ? [{ id: 'sub_1', snippet: { resourceId: { channelId: forChannelId } } }] : [],
      });
    }
  }

  return json(res, 404, { error: { code: 404 } });
});

export function start(port) {
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

export function stop() {
  return new Promise((resolve) => server.close(resolve));
}

import { env } from '../../config/env.js';
import { Errors } from '../../utils/AppError.js';

// Thin, typed wrapper over the two YouTube Data API v3 reads this feature
// needs. Every call here is made with an OWNER'S access token - the agent's
// when identifying their channel, the user's when checking a subscription -
// never with an API key or a service account, because both questions are
// only answerable as the authenticated account.
const YOUTUBE_API_BASE = env.youtubeApiBaseUrl;

interface YouTubeErrorPayload {
  error?: { code?: number; message?: string; errors?: { reason?: string }[] };
}

async function youtubeGet<T>(path: string, params: Record<string, string>, accessToken: string): Promise<T> {
  const url = `${YOUTUBE_API_BASE}/${path}?${new URLSearchParams(params).toString()}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(env.googleApiTimeoutMs),
    });
  } catch {
    throw Errors.conflict('YOUTUBE_UNREACHABLE', 'Could not reach YouTube right now. Please try again in a moment.');
  }

  if (response.ok) return (await response.json()) as T;

  const payload = (await response.json().catch(() => ({}))) as YouTubeErrorPayload;
  const reason = payload.error?.errors?.[0]?.reason ?? '';

  // Logged without the token, the URL's query string, or Google's own
  // message (which can echo request content back) - just the shape of the
  // failure, which is all that is ever needed to diagnose one (spec §15).
  console.error('[youtube.service] YouTube API call failed', { path, status: response.status, reason });

  // 401 is always a dead credential. 403 usually is too (the grant was
  // narrowed or revoked), with one important exception: quota exhaustion is
  // a server-side problem and must never tell a user to reconnect a
  // perfectly good account.
  if (response.status === 401) throw Errors.googleReauthRequired();
  if (response.status === 403) {
    if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
      throw Errors.conflict('YOUTUBE_QUOTA_EXCEEDED', 'YouTube verification is temporarily unavailable. Please try again later.');
    }
    throw Errors.googleReauthRequired('YouTube access was not granted or has been revoked. Please reconnect your Google account.');
  }

  throw Errors.conflict('YOUTUBE_API_ERROR', 'YouTube could not be reached right now. Please try again in a moment.');
}

// ---------------------------------------------------------------------------
// Channel identity (agent side)
// ---------------------------------------------------------------------------

export interface YouTubeChannel {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  channelUrl: string | null;
}

interface ChannelListResponse {
  items?: {
    id?: string;
    snippet?: {
      title?: string;
      customUrl?: string;
      thumbnails?: Record<string, { url?: string } | undefined>;
    };
  }[];
}

// `mine=true` is the whole point: it resolves the channel from the grant
// itself, so the id that comes back is one the authorizing account provably
// controls. Returns null (rather than throwing) for a Google account with no
// channel at all, which is an ordinary situation the caller reports with its
// own message.
export async function fetchMyChannel(accessToken: string): Promise<YouTubeChannel | null> {
  const data = await youtubeGet<ChannelListResponse>('channels', { part: 'snippet', mine: 'true' }, accessToken);
  const item = data.items?.[0];
  if (!item?.id) return null;

  const thumbnails = item.snippet?.thumbnails ?? {};
  const thumbnailUrl = thumbnails['high']?.url ?? thumbnails['medium']?.url ?? thumbnails['default']?.url ?? null;
  const customUrl = item.snippet?.customUrl;

  return {
    id: item.id,
    title: item.snippet?.title ?? 'YouTube Channel',
    thumbnailUrl,
    // The /channel/UC... form always resolves, so it is what gets stored;
    // the handle (@name) is preferred when YouTube provides one because it
    // is what a person recognizes when the link opens.
    channelUrl: customUrl ? `https://www.youtube.com/${customUrl.startsWith('@') ? customUrl : `c/${customUrl}`}` : `https://www.youtube.com/channel/${item.id}`,
  };
}

// ---------------------------------------------------------------------------
// Subscription check (user side)
// ---------------------------------------------------------------------------

interface SubscriptionListResponse {
  items?: { id?: string; snippet?: { resourceId?: { channelId?: string } } }[];
}

// The one question the whole feature turns on, asked the cheap and correct
// way: `mine=true` scopes the query to the AUTHENTICATED user's own
// subscriptions, and `forChannelId` asks YouTube to filter to just the target
// channel - so this is a single request with at most one row back, not a
// walk through anyone's subscriber or subscription list (spec §10).
//
// Deliberately NOT the agent-side equivalent: there is a
// subscriptions?myRecentSubscribers form, but it is capped, unordered and
// tells you nothing reliable about one specific person - which is exactly
// why spec §22 rules it out.
export async function isSubscribedToChannel(accessToken: string, channelId: string): Promise<boolean> {
  const data = await youtubeGet<SubscriptionListResponse>(
    'subscriptions',
    { part: 'snippet', mine: 'true', forChannelId: channelId, maxResults: '1' },
    accessToken,
  );

  // The returned row's own channelId is re-checked rather than trusting the
  // server-side filter blindly: matching is on the channel ID and nothing
  // else, never on the channel name (spec §22). An empty `items` is the
  // honest "not subscribed" answer.
  return (data.items ?? []).some((item) => item.snippet?.resourceId?.channelId === channelId);
}

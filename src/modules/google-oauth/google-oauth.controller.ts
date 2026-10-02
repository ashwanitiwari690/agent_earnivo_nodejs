import { Request, Response } from 'express';
import { AppError } from '../../utils/AppError.js';
import { getAgentProfileByUserId } from '../agents/agents.service.js';
import * as googleOAuth from './google-oauth.service.js';

// The agent's OWN AgentProfile id, derived from the authenticated session -
// never read from the request, exactly as every campaign route already does
// it (campaigns.controller.ts).
async function agentIdOf(req: Request): Promise<string> {
  const agent = await getAgentProfileByUserId(req.user!.id);
  return agent.id;
}

export async function agentAuthorizeUrlHandler(req: Request, res: Response) {
  const authUrl = googleOAuth.buildAuthorizeUrl('AGENT', await agentIdOf(req));
  res.json({ success: true, data: { authUrl } });
}

export async function userAuthorizeUrlHandler(req: Request, res: Response) {
  const authUrl = googleOAuth.buildAuthorizeUrl('USER', req.user!.id);
  res.json({ success: true, data: { authUrl } });
}

export async function agentConnectionHandler(req: Request, res: Response) {
  res.json({ success: true, data: await googleOAuth.getAgentConnection(await agentIdOf(req)) });
}

export async function refreshAgentChannelHandler(req: Request, res: Response) {
  res.json({ success: true, data: await googleOAuth.refreshAgentChannel(await agentIdOf(req)) });
}

export async function disconnectAgentHandler(req: Request, res: Response) {
  res.json({ success: true, data: await googleOAuth.disconnect('AGENT', await agentIdOf(req)) });
}

export async function userConnectionHandler(req: Request, res: Response) {
  res.json({ success: true, data: await googleOAuth.getUserConnection(req.user!.id) });
}

export async function disconnectUserHandler(req: Request, res: Response) {
  res.json({ success: true, data: await googleOAuth.disconnect('USER', req.user!.id) });
}

// ---------------------------------------------------------------------------
// OAuth callback
// ---------------------------------------------------------------------------

// Channel titles come from YouTube and error messages pass through this
// module, so neither is trusted as markup - this page is assembled by string
// concatenation, which is exactly the situation escaping exists for.
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

// Deliberately hand-authored, dependency-free HTML, for the same reason the
// referral landing page is (referral-landing.controller.ts): this renders
// inside a Capacitor in-app browser on a phone, and loading an application
// bundle to say five words would be absurd. It is also the only thing the
// Ionic user ever sees of the OAuth round trip - the app itself re-reads its
// connection status once this window closes.
function resultPage(title: string, message: string, ok: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f7f7fb;
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a1a2e; }
  .card { background: #fff; border-radius: 16px; padding: 32px 24px; max-width: 360px; margin: 20px; text-align: center;
          box-shadow: 0 4px 20px rgba(0,0,0,.06); }
  .badge { width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 16px; display: flex; align-items: center;
           justify-content: center; font-size: 28px; color: #fff; background: ${ok ? '#16a34a' : '#dc2626'}; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { margin: 0; font-size: 14px; color: #6b7280; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">${ok ? '&#10003;' : '!'}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

// Unauthenticated by necessity - the browser arriving here comes from
// Google, not from an app holding a bearer token. The signed `state` is the
// credential, and handleCallback rejects anything it did not sign itself.
export async function callbackHandler(req: Request, res: Response) {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  // Google sends this instead of a code when someone presses Cancel on the
  // consent screen - an ordinary outcome, not an error worth a stack trace.
  const oauthError = typeof req.query.error === 'string' ? req.query.error : '';

  if (oauthError || !code || !state) {
    const message = oauthError === 'access_denied' ? 'You cancelled the Google sign-in. Nothing was connected.' : 'The Google authorization could not be completed.';
    return res.status(400).send(resultPage('Not connected', message, false));
  }

  try {
    const result = await googleOAuth.handleCallback(code, state);
    // The agent panel has a real screen to return to; the Ionic user app has
    // none, so it gets this page and picks the new state up on its own.
    if (result.redirectUrl) return res.redirect(result.redirectUrl);
    return res.send(
      resultPage(
        'Google account connected',
        result.channelName
          ? `Your YouTube channel "${result.channelName}" is now verified. You can close this window and return to the app.`
          : 'You can close this window and return to the app.',
        true,
      ),
    );
  } catch (err) {
    // A failure here has nowhere useful to throw: the caller is a browser
    // following a redirect from Google, and the JSON error envelope every
    // other route returns would render as raw text on the screen. The
    // message is one of this module's own (already user-safe); anything
    // unexpected is deliberately generic.
    // An AppError's message is one this module wrote and already phrased for
    // the person reading it. Anything else is unexpected and gets a generic
    // line rather than leaking an internal failure onto a public page.
    const message = err instanceof AppError ? err.message : 'Something went wrong while connecting your Google account.';
    const landing = googleOAuth.landingUrlFor(stateOwnerTypeGuess(state), { google: 'error', message });
    if (landing) return res.redirect(landing);
    return res.status(400).send(resultPage('Not connected', message, false));
  }
}

// Best-effort read of the owner type from an unverified state, used only to
// decide WHERE to show an error - never to grant anything. A tampered state
// gets the fallback page instead of a redirect, which is the safe direction.
function stateOwnerTypeGuess(state: string): googleOAuth.OwnerType {
  try {
    const claims = JSON.parse(Buffer.from(state.split('.')[1], 'base64url').toString('utf8')) as { ownerType?: string };
    return claims.ownerType === 'AGENT' ? 'AGENT' : 'USER';
  } catch {
    return 'USER';
  }
}

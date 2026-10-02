import { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { validateReferralCode } from './referrals.service.js';

const APP_NAME = 'Earnivo';

// The referral share buttons (angular-ionic's referral.page.ts) hand this
// page's URL to WhatsApp/Facebook/etc. rather than a paragraph of text -
// Facebook in particular strips any pre-filled caption to stop spam, so the
// og: tags below are what actually put the app name, a real description and
// an image on the message/post, not the raw share text.
const OG_IMAGE_PATH = '/assets/branding/logo-mark.png';
const OG_IMAGE_SIZE = 112; // matches the checked-in PNG's actual dimensions

interface PageMeta {
  title: string;
  description: string;
  url: string;
}

// Deliberately hand-authored, dependency-free HTML - no framework bundle,
// no external font/script requests, inline CSS only (spec Phase 9 §17: "do
// not load the entire application bundle just to display the referral
// landing page", "load quickly even on mobile networks"). This is served
// directly by the backend rather than the Ionic app for exactly that
// reason - the whole point is to be lighter than the app it's promoting.
function pageShell(bodyHtml: string, meta: PageMeta): string {
  const imageUrl = `${env.publicWebUrl}${OG_IMAGE_PATH}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${meta.title}</title>
<meta name="description" content="${meta.description}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${APP_NAME}">
<meta property="og:title" content="${meta.title}">
<meta property="og:description" content="${meta.description}">
<meta property="og:url" content="${meta.url}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="${OG_IMAGE_SIZE}">
<meta property="og:image:height" content="${OG_IMAGE_SIZE}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${meta.title}">
<meta name="twitter:description" content="${meta.description}">
<meta name="twitter:image" content="${imageUrl}">
<style>
  :root { --p: #7040e8; --p2: #8b5cf6; --ink: #1a1a2e; --muted: #6b7280; --bg: #f7f7fb; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--ink); }
  .hero { background: linear-gradient(135deg, var(--p), var(--p2)); color: #fff; padding: 40px 20px 56px; text-align: center; }
  .logo { font-weight: 800; font-size: 22px; letter-spacing: .5px; }
  .logo span { opacity: .8; }
  .hero h1 { font-size: 26px; margin: 18px 0 8px; }
  .hero p { margin: 0; opacity: .92; font-size: 15px; max-width: 420px; margin-left: auto; margin-right: auto; }
  .wrap { max-width: 480px; margin: -28px auto 0; padding: 0 20px 40px; }
  .card { background: #fff; border-radius: 16px; padding: 20px; margin-bottom: 14px; box-shadow: 0 4px 20px rgba(0,0,0,.06); }
  .card h2 { font-size: 15px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); }
  .benefit { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
  .benefit:last-child { margin-bottom: 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--p); margin-top: 6px; flex-shrink: 0; }
  .benefit strong { display: block; font-size: 14px; }
  .benefit small { color: var(--muted); font-size: 13px; }
  .steps { counter-reset: step; list-style: none; padding: 0; margin: 0; }
  .steps li { counter-increment: step; padding-left: 34px; position: relative; margin-bottom: 12px; font-size: 14px; }
  .steps li:last-child { margin-bottom: 0; }
  .steps li::before { content: counter(step); position: absolute; left: 0; top: -1px; width: 22px; height: 22px; border-radius: 50%; background: #f1ecff; color: var(--p); font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .cta { display: block; text-align: center; background: linear-gradient(135deg, var(--p), var(--p2)); color: #fff; text-decoration: none; font-weight: 700; padding: 15px; border-radius: 12px; font-size: 15px; margin-top: 4px; }
  .fineprint { text-align: center; color: var(--muted); font-size: 12px; margin-top: 16px; line-height: 1.5; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

function genericLanding(pageUrl: string): string {
  const appUrl = env.ionicAppUrl;
  return pageShell(
    `
    <div class="hero">
      <div class="logo">${APP_NAME}<span>.</span></div>
      <h1>Earn rewards your way</h1>
      <p>Complete eligible tasks, participate in surveys, and discover campaigns from real brands.</p>
    </div>
    <div class="wrap">
      <div class="card">
        <h2>Get Started</h2>
        <div class="benefit"><div class="dot"></div><div><strong>Complete eligible tasks</strong><small>Simple activities from brands and businesses.</small></div></div>
        <div class="benefit"><div class="dot"></div><div><strong>Participate in surveys</strong><small>Share your opinion, earn a reward.</small></div></div>
        <div class="benefit"><div class="dot"></div><div><strong>Earn real rewards</strong><small>Rewards go straight to your in-app wallet.</small></div></div>
      </div>
      <a class="cta" href="${appUrl}/login">Get Started</a>
      <p class="fineprint">Rewards vary by activity and are credited after eligibility checks.</p>
    </div>
  `,
    {
      title: `${APP_NAME} - Earn Rewards`,
      description: 'Complete eligible tasks, participate in surveys, and discover campaigns from real brands.',
      url: pageUrl,
    },
  );
}

function referralLanding(code: string, pageUrl: string): string {
  const appUrl = env.ionicAppUrl;
  const ctaHref = `${appUrl}/login?ref=${encodeURIComponent(code)}`;
  return pageShell(
    `
    <div class="hero">
      <div class="logo">${APP_NAME}<span>.</span></div>
      <h1>You've been invited to ${APP_NAME}</h1>
      <p>A friend thinks you'd like earning rewards for completing tasks, surveys, and campaigns.</p>
    </div>
    <div class="wrap">
      <div class="card">
        <h2>What You Can Do</h2>
        <div class="benefit"><div class="dot"></div><div><strong>Complete eligible tasks</strong><small>Simple, real activities from brands and businesses.</small></div></div>
        <div class="benefit"><div class="dot"></div><div><strong>Participate in surveys</strong><small>Share your opinion, earn a reward.</small></div></div>
        <div class="benefit"><div class="dot"></div><div><strong>Discover campaigns</strong><small>New opportunities to earn, added regularly.</small></div></div>
        <div class="benefit"><div class="dot"></div><div><strong>Earn rewards</strong><small>Reward amounts depend on the activity and are credited after eligibility checks.</small></div></div>
      </div>
      <div class="card">
        <h2>How It Works</h2>
        <ol class="steps">
          <li>Open the app and verify your mobile number</li>
          <li>Browse available tasks, surveys, and campaigns</li>
          <li>Complete an activity and earn a reward</li>
        </ol>
      </div>
      <a class="cta" href="${ctaHref}">Get Started</a>
      <p class="fineprint">Your invite is applied automatically when you sign up.<br>Rewards vary by activity and are credited after eligibility checks.</p>
    </div>
  `,
    {
      title: `You've been invited to ${APP_NAME}`,
      description: 'Complete eligible tasks, participate in surveys, and discover campaigns to start earning real rewards.',
      url: pageUrl,
    },
  );
}

export async function referralLandingHandler(req: Request, res: Response) {
  const code = String(req.params.code ?? '').trim();
  // Never exposes *why* a code failed (spec §5: "Do not expose internal
  // database information") - an invalid, expired, or malformed code all
  // fall back to the exact same generic page.
  const { valid } = code ? await validateReferralCode(code) : { valid: false };
  const pageUrl = `${env.publicWebUrl}${req.originalUrl}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(valid ? referralLanding(code, pageUrl) : genericLanding(pageUrl));
}

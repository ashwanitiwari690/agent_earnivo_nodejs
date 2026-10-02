import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
      // Reuses a small set of SMTP connections instead of completing a TCP
      // and TLS handshake per message. Registration awaits the send, so that
      // handshake was sitting directly in the signup response time.
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      // Every stage gets a ceiling. An SMTP server that accepts the socket
      // and then stops responding is the worst case here, because without
      // these the send - and the request waiting on it - never returns.
      connectionTimeout: env.smtpTimeoutMs,
      greetingTimeout: env.smtpTimeoutMs,
      socketTimeout: env.smtpTimeoutMs,
    });
  }
  return transporter;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  return `${local.slice(0, 2)}***@${domain}`;
}

// Single branded shell every transactional email renders through - inline
// CSS only (email clients strip <style> blocks/external stylesheets), a
// real fallback link for clients that block the button, and a plain-text
// alternative for text-only inboxes. Keeping one shell function means every
// future transactional email (password reset, etc.) gets the same look for
// free instead of a copy-pasted template per email type.
function renderEmailShell(opts: { previewText: string; bodyHtml: string }): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
  <body style="margin:0; padding:0; background-color:#f3f4f6; font-family:'Segoe UI', Arial, sans-serif;">
    <span style="display:none; max-height:0; overflow:hidden;">${opts.previewText}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.08);">
            <tr>
              <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed); padding:28px 32px;">
                <span style="font-size:22px; font-weight:700; color:#ffffff; letter-spacing:0.3px;">Earnivo</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                ${opts.bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px; background-color:#f9fafb; border-top:1px solid #eef0f3;">
                <p style="margin:0; font-size:12px; color:#9ca3af; line-height:1.5;">
                  You're receiving this email because this address was used to sign up for an Earnivo agent account.
                  If this wasn't you, you can safely ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderVerificationEmail(name: string, verifyUrl: string): { html: string; text: string } {
  const bodyHtml = `
    <h1 style="margin:0 0 12px; font-size:20px; color:#111827;">Verify your email address</h1>
    <p style="margin:0 0 20px; font-size:14px; color:#4b5563; line-height:1.6;">
      Hi ${escapeHtml(name)}, thanks for registering as an agent on Earnivo. Confirm this email address to
      activate your account and start creating campaigns.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr>
        <td style="border-radius:8px; background-color:#4f46e5;">
          <a href="${verifyUrl}" target="_blank"
             style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:8px;">
            Verify Email Address
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px; font-size:13px; color:#6b7280;">Or paste this link into your browser:</p>
    <p style="margin:0 0 20px; font-size:13px; word-break:break-all;"><a href="${verifyUrl}" style="color:#4f46e5;">${verifyUrl}</a></p>
    <p style="margin:0; font-size:12px; color:#9ca3af;">This link expires in 24 hours. If you didn't create this account, no action is needed.</p>
  `;

  const text = `Hi ${name},\n\nThanks for registering as an agent on Earnivo. Verify your email to activate your account:\n\n${verifyUrl}\n\nThis link expires in 24 hours. If you didn't create this account, no action is needed.`;

  return { html: renderEmailShell({ previewText: 'Verify your email to activate your Earnivo agent account.', bodyHtml }), text };
}

function renderPasswordResetEmail(name: string, resetUrl: string): { html: string; text: string } {
  const bodyHtml = `
    <h1 style="margin:0 0 12px; font-size:20px; color:#111827;">Reset your password</h1>
    <p style="margin:0 0 20px; font-size:14px; color:#4b5563; line-height:1.6;">
      Hi ${escapeHtml(name)}, we received a request to reset the password on your Earnivo account. Click below to
      choose a new one.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr>
        <td style="border-radius:8px; background-color:#4f46e5;">
          <a href="${resetUrl}" target="_blank"
             style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:8px;">
            Reset Password
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px; font-size:13px; color:#6b7280;">Or paste this link into your browser:</p>
    <p style="margin:0 0 20px; font-size:13px; word-break:break-all;"><a href="${resetUrl}" style="color:#4f46e5;">${resetUrl}</a></p>
    <p style="margin:0; font-size:12px; color:#9ca3af;">This link expires in 30 minutes. If you didn't request this, you can safely ignore this email - your password will stay unchanged.</p>
  `;

  const text = `Hi ${name},\n\nWe received a request to reset the password on your Earnivo account:\n\n${resetUrl}\n\nThis link expires in 30 minutes. If you didn't request this, you can safely ignore this email.`;

  return { html: renderEmailShell({ previewText: 'Reset the password on your Earnivo account.', bodyHtml }), text };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// Shared dispatcher for every transactional email - the dev-only escape
// hatch (mirroring whatsapp.service.ts's OTP-bypass pattern exactly: without
// real SMTP credentials nothing can actually be delivered, so local/testing
// runs log the link instead of failing outright) and the production error
// handling only need to exist once, not once per email type.
async function dispatch(to: string, subject: string, devLabel: string, devUrl: string, render: () => { html: string; text: string }): Promise<void> {
  if (!env.smtpHost) {
    if (env.nodeEnv === 'production') {
      throw new AppError(502, 'EMAIL_SEND_FAILED', 'Email provider is not configured.');
    }
    console.warn(`[email.service] SMTP_HOST not set - dev ${devLabel} link for ${maskEmail(to)}: ${devUrl}`);
    return;
  }

  const { html, text } = render();

  try {
    await getTransporter().sendMail({ from: `"${env.smtpFromName}" <${env.smtpFromEmail}>`, to, subject, html, text });
  } catch (err) {
    console.error(`[email.service] Failed to send ${devLabel} email`, { to: maskEmail(to), err });
    if (env.nodeEnv === 'production') {
      throw new AppError(502, 'EMAIL_SEND_FAILED', `Failed to send ${devLabel} email. Please try again shortly.`);
    }
    // Dev/test: SMTP is configured but the test credentials may not be live
    // yet - don't block testing on that, the caller already exposes the raw
    // link separately for this exact reason.
  }
}

export async function sendVerificationEmail(to: string, name: string, verifyUrl: string): Promise<void> {
  await dispatch(to, 'Verify your email - Earnivo', 'verification', verifyUrl, () => renderVerificationEmail(name, verifyUrl));
}

export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string): Promise<void> {
  await dispatch(to, 'Reset your password - Earnivo', 'password-reset', resetUrl, () => renderPasswordResetEmail(name, resetUrl));
}

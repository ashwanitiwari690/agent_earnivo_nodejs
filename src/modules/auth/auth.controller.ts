import { Request, Response } from 'express';
import { env } from '../../config/env.js';
import * as authService from './auth.service.js';

const REFRESH_COOKIE = 'refresh_token';

function setRefreshCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: 'strict',
    expires: expiresAt,
    path: '/api/auth',
  });
}

export async function registerHandler(req: Request, res: Response) {
  // No session is issued at registration anymore - the account can't sign in
  // until its email is verified (see authService.verifyEmail).
  const result = await authService.register(req.body);
  res.status(201).json({ success: true, data: result });
}

export async function loginHandler(req: Request, res: Response) {
  const { accessToken, refreshToken, refreshExpiresAt, user } = await authService.login(req.body);
  setRefreshCookie(res, refreshToken, refreshExpiresAt);
  res.json({ success: true, data: { user, accessToken } });
}

// Web clients send the refresh token as an httpOnly cookie; the Ionic app
// has no cookie jar semantics worth relying on, so it sends the token it
// stored in secure device storage in the body instead. Both are accepted
// here rather than forking this endpoint per client.
export async function refreshHandler(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
  const { accessToken, refreshToken, refreshExpiresAt, user } = await authService.refresh(token);
  setRefreshCookie(res, refreshToken, refreshExpiresAt);
  res.json({ success: true, data: { user, accessToken, refreshToken } });
}

export async function logoutHandler(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
  await authService.logout(token);
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  res.json({ success: true, data: null });
}

export async function meHandler(req: Request, res: Response) {
  const user = await authService.getById(req.user!.id);
  res.json({ success: true, data: user });
}

export async function forgotPasswordHandler(req: Request, res: Response) {
  const result = await authService.forgotPassword(req.body.email);
  res.json({ success: true, data: result });
}

export async function resetPasswordHandler(req: Request, res: Response) {
  const result = await authService.resetPassword(req.body.token, req.body.newPassword);
  res.json({ success: true, data: result });
}

// Clicking the emailed link lands the agent on this endpoint (via the
// Angular verify-email page) and, on success, grants access immediately -
// same session shape as login/register used to return.
export async function verifyEmailHandler(req: Request, res: Response) {
  const { accessToken, refreshToken, refreshExpiresAt, user } = await authService.verifyEmail(req.body.token);
  setRefreshCookie(res, refreshToken, refreshExpiresAt);
  res.json({ success: true, data: { user, accessToken } });
}

export async function resendVerificationEmailHandler(req: Request, res: Response) {
  const result = await authService.resendVerificationEmail(req.body.email);
  res.json({ success: true, data: result });
}

// Entering the WhatsApp OTP sent at registration lands here and, on success,
// grants access immediately - same session shape as verifyEmailHandler above.
export async function verifyAgentOtpHandler(req: Request, res: Response) {
  const { accessToken, refreshToken, refreshExpiresAt, user } = await authService.verifyAgentPhoneOtp(req.body.phone, req.body.otp);
  setRefreshCookie(res, refreshToken, refreshExpiresAt);
  res.json({ success: true, data: { user, accessToken } });
}

export async function resendAgentOtpHandler(req: Request, res: Response) {
  const result = await authService.resendAgentPhoneOtp(req.body.phone);
  res.json({ success: true, data: result });
}

import { Request, Response } from 'express';
import { env } from '../../config/env.js';
import * as userAuthService from './user-auth.service.js';

const REFRESH_COOKIE = 'refresh_token';

export async function sendOtpHandler(req: Request, res: Response) {
  const { phone, referralCode } = req.body;
  await userAuthService.sendOtp(phone, referralCode);
  res.json({ success: true, data: { message: 'OTP sent successfully.' } });
}

export async function verifyOtpHandler(req: Request, res: Response) {
  const { phone, otp, deviceId, platform, appVersion, referralCode } = req.body;
  const result = await userAuthService.verifyOtpAndAuthenticate(phone, otp, { deviceId, platform, appVersion }, referralCode);

  res.cookie(REFRESH_COOKIE, result.refreshToken, {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: 'strict',
    expires: result.refreshExpiresAt,
    path: '/api/auth',
  });

  res.status(result.isNewUser ? 201 : 200).json({
    success: true,
    data: {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
      isNewUser: result.isNewUser,
      referralWarning: result.referralWarning,
    },
  });
}

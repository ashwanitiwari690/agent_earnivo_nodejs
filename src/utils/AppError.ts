export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthorized: (message = 'Authentication required.') => new AppError(401, 'UNAUTHORIZED', message),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.'),
  emailNotVerified: () =>
    new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email address before signing in. Check your inbox for the verification link.'),
  phoneNotVerified: () =>
    new AppError(403, 'PHONE_NOT_VERIFIED', 'Please verify your mobile number with the WhatsApp OTP sent during registration before signing in.'),
  forbidden: (message = 'You do not have permission to perform this action.') => new AppError(403, 'FORBIDDEN', message),
  userSuspended: () => new AppError(403, 'USER_SUSPENDED', 'This account has been suspended.'),
  notFound: (entity: string) => new AppError(404, 'NOT_FOUND', `${entity} not found.`),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  // A stored Google OAuth grant that can no longer be used - revoked from
  // the owner's Google account settings, expired past recovery, or never
  // carrying a usable refresh token. Its own named error rather than a
  // conflict() call at each site because every client branches on this exact
  // code to show one specific state ("reconnect your Google account"), and
  // because both the OAuth service and the YouTube client raise it - keeping
  // it here is what stops those two modules importing each other.
  googleReauthRequired: (message = 'Your Google connection has expired. Please reconnect your Google account.') =>
    new AppError(409, 'GOOGLE_REAUTH_REQUIRED', message),
  validation: (message: string) => new AppError(422, 'VALIDATION_ERROR', message),
  invalidReferralCode: () => new AppError(422, 'INVALID_REFERRAL_CODE', 'Your referral code is invalid. Please enter a valid referral code.'),
};

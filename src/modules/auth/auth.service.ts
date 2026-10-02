import { randomBytes, createHash } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { signAccessToken } from '../../utils/jwt.js';
import { generateRefreshToken, hashRefreshToken } from '../../utils/refreshToken.js';
import { Errors } from '../../utils/AppError.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { notifyAdmins } from '../notifications/notifications.service.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../../services/email.service.js';
import * as otpService from '../otp/otp.service.js';
import { env } from '../../config/env.js';

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function buildVerificationUrl(rawToken: string): string {
  return `${env.agentAdminUrl}/auth/verify-email?token=${rawToken}`;
}

function buildPasswordResetUrl(rawToken: string): string {
  return `${env.agentAdminUrl}/auth/reset-password?token=${rawToken}`;
}

export function serializeUser(user: {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  role: { code: string };
  agentProfile: { id: string; name: string; status: string; verificationStatus: string; profileImage: string | null } | null;
}) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    name: user.name,
    role: user.role.code,
    agent: user.agentProfile
      ? {
          id: user.agentProfile.id,
          name: user.agentProfile.name,
          status: user.agentProfile.status,
          verificationStatus: user.agentProfile.verificationStatus,
          profileImage: user.agentProfile.profileImage,
        }
      : null,
  };
}

export interface DeviceMeta {
  deviceId?: string | null;
  platform?: string | null;
  appVersion?: string | null;
}

export async function issueSession(userId: string, role: 'USER' | 'AGENT' | 'ADMIN', deviceMeta?: DeviceMeta) {
  const accessToken = signAccessToken({ sub: userId, role });
  const refresh = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
      deviceId: deviceMeta?.deviceId,
      platform: deviceMeta?.platform,
      appVersion: deviceMeta?.appVersion,
    },
  });
  return { accessToken, refreshToken: refresh.token, refreshExpiresAt: refresh.expiresAt };
}

// This endpoint only ever creates AGENT accounts (hardcoded role lookup
// below) - there is exactly one Admin account, provisioned once via
// prisma/seed.ts, never through self-registration.
//
// Registration no longer auto-issues a session: the account is created with
// phoneVerified: false and cannot sign in (see login()'s gate below) until
// the agent verifies the WhatsApp OTP sent to their phone (verifyAgentPhoneOtp
// below). This closes the actual bug that was reported - the Angular register
// page was a fully static mock that never called this endpoint at all, so no
// account was ever created despite the UI showing a success message.
//
// This stands in for the email-link verification the endpoint used to send
// (registerSchema still collects an email, and verifyEmail/
// resendVerificationEmail below are left fully working) because real SMTP
// credentials aren't confirmed working yet - WhatsApp is the one delivery
// channel that reliably reaches the agent today. Swap this back once SMTP is
// ready: restore the token-generation + sendVerificationEmail call here and
// the `if (!user.emailVerified)` gate in login() below.
export async function register(input: { name: string; email: string; phone: string; password: string; businessName?: string }) {
  const existingEmail = await prisma.user.findUnique({ where: { email: input.email } });
  if (existingEmail) throw Errors.conflict('EMAIL_TAKEN', 'An account with this email already exists.');

  const normalizedPhone = otpService.normalizePhone(input.phone);
  const existingPhone = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
  if (existingPhone) throw Errors.conflict('PHONE_TAKEN', 'An account with this phone number already exists.');

  const [agentRole, freePlan] = await Promise.all([
    prisma.role.findUniqueOrThrow({ where: { code: 'AGENT' } }),
    prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } }),
  ]);
  const passwordHash = await hashPassword(input.password);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        phone: normalizedPhone,
        passwordHash,
        roleId: agentRole.id,
      },
    });

    const agentProfile = await tx.agentProfile.create({
      data: {
        userId: user.id,
        name: input.name,
        email: input.email,
        phone: normalizedPhone,
        businessName: input.businessName,
        status: 'PENDING',
        verificationStatus: 'UNVERIFIED',
      },
    });

    const subscription = await tx.agentSubscription.create({
      data: {
        agentId: agentProfile.id,
        planId: freePlan.id,
        status: 'ACTIVE',
        isTrial: true,
        trialUsed: false,
        startedAt: new Date(),
      },
    });

    await tx.subscriptionUsage.create({
      data: {
        agentId: agentProfile.id,
        subscriptionId: subscription.id,
        trialUsed: false,
      },
    });

    return { user, agentProfile };
  });

  await writeAuditLog({
    userId: result.user.id,
    action: 'AGENT_REGISTERED',
    entityType: 'agent_profiles',
    entityId: result.agentProfile.id,
    metadata: { email: input.email },
  });

  // notifyAdmins() happens in verifyAgentPhoneOtp() instead - an unverified
  // signup attempt isn't a real agent yet, so admins shouldn't be alerted
  // about it until the phone is confirmed.
  await otpService.requestOtp(normalizedPhone);

  return {
    message: 'Registration successful! We sent a verification code to your WhatsApp number. Enter it to activate your account.',
    phone: normalizedPhone,
  };
}

// Activates a self-registered agent account, mirroring verifyEmail() above
// exactly (same "grants access immediately" behavior) but keyed by a
// verified WhatsApp OTP instead of an emailed token. otpService's
// verify/consume pair is role-agnostic - it only knows about a phone number,
// never a User row - so the actual account lookup and activation happen here.
export async function verifyAgentPhoneOtp(rawPhone: string, otp: string) {
  await otpService.verifyOtp(rawPhone, otp);
  const normalizedPhone = otpService.normalizePhone(rawPhone);

  const updated = await prisma.$transaction(async (tx) => {
    await otpService.consumeVerifiedOtp(tx, rawPhone);

    const user = await tx.user.findUnique({
      where: { phone: normalizedPhone },
      include: { role: true, agentProfile: true },
    });
    if (!user || user.role.code !== 'AGENT') {
      throw Errors.validation('No pending agent registration was found for this phone number.');
    }

    return tx.user.update({
      where: { id: user.id },
      data: { phoneVerified: true },
      include: { role: true, agentProfile: true },
    });
  });

  await writeAuditLog({ userId: updated.id, action: 'AGENT_PHONE_VERIFIED', entityType: 'users', entityId: updated.id });

  if (updated.agentProfile) {
    await notifyAdmins({
      type: 'NEW_AGENT',
      title: 'New agent registered',
      message: `${updated.agentProfile.name} (${updated.email}) verified their phone and joined.`,
      metadata: { agentId: updated.agentProfile.id },
    });
  }

  const session = await issueSession(updated.id, updated.role.code as 'USER' | 'AGENT' | 'ADMIN');
  return { user: serializeUser(updated), ...session };
}

// Same non-enumerating shape as resendVerificationEmail() below: never
// reveals whether the phone belongs to a real, still-unverified registration
// - it only actually resends when it does.
export async function resendAgentPhoneOtp(rawPhone: string) {
  const generic = { message: 'If a pending agent registration exists for this phone number, a new code has been sent.' };
  const normalizedPhone = otpService.normalizePhone(rawPhone);
  const user = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
  if (!user || user.phoneVerified) return generic;

  await otpService.requestOtp(rawPhone);
  return generic;
}

export async function verifyEmail(rawToken: string) {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const user = await prisma.user.findFirst({
    where: { emailVerificationTokenHash: tokenHash, emailVerificationExpiresAt: { gt: new Date() } },
    include: { role: true, agentProfile: true },
  });
  if (!user) throw Errors.validation('This verification link is invalid or has expired.');

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: true, emailVerificationTokenHash: null, emailVerificationExpiresAt: null },
    include: { role: true, agentProfile: true },
  });

  await writeAuditLog({ userId: updated.id, action: 'AGENT_EMAIL_VERIFIED', entityType: 'users', entityId: updated.id });

  if (updated.agentProfile) {
    await notifyAdmins({
      type: 'NEW_AGENT',
      title: 'New agent registered',
      message: `${updated.agentProfile.name} (${updated.email}) verified their email and joined.`,
      metadata: { agentId: updated.agentProfile.id },
    });
  }

  // Verifying grants access immediately (spec: "click verify -> access the
  // account") - no separate login step required.
  const session = await issueSession(updated.id, updated.role.code as 'USER' | 'AGENT' | 'ADMIN');
  return { user: serializeUser(updated), ...session };
}

// Same non-enumerating shape as forgotPassword() below: the response never
// reveals whether the email exists, is already verified, or has no password
// account at all - it only actually resends when all three conditions for a
// legitimate resend are met.
export async function resendVerificationEmail(email: string) {
  const generic = { message: 'If an account with this email needs verification, a new link has been sent.' };
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.emailVerified || !user.passwordHash) return generic;

  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerificationTokenHash: tokenHash, emailVerificationExpiresAt: expiresAt },
  });

  const verifyUrl = buildVerificationUrl(rawToken);
  await sendVerificationEmail(email, user.name ?? 'there', verifyUrl);

  return {
    ...generic,
    ...(env.nodeEnv !== 'production' ? { devVerificationUrl: verifyUrl } : {}),
  };
}

export async function getById(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { role: true, agentProfile: true },
  });
  return serializeUser(user);
}

export async function login(input: { email: string; password: string }) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { role: true, agentProfile: true },
  });
  if (!user || !user.passwordHash) throw Errors.invalidCredentials();

  const passwordOk = await verifyPassword(input.password, user.passwordHash);
  if (!passwordOk) throw Errors.invalidCredentials();

  // Every email+password account (Agent self-registration, and the one
  // seeded Admin) must have a verified email before signing in. The seed
  // script sets emailVerified: true for the Admin account directly, so this
  // never blocks it in practice.
  //
  // TEMPORARY BYPASS: SMTP is not configured yet, so verification emails can
  // never actually be delivered - agents would be locked out permanently.
  // Gate disabled until real SMTP credentials exist; uncomment the line
  // below (alongside restoring the email flow in register()) to bring it
  // back, likely alongside - not instead of - the phone gate right below.
  // if (!user.emailVerified) throw Errors.emailNotVerified();

  // Stands in for the email gate above until SMTP is confirmed working: a
  // self-registered agent verifies their phone via a WhatsApp OTP right
  // after registering (see register()/verifyAgentPhoneOtp()), which is the
  // one delivery channel that reliably reaches them today. Admin-created
  // agents (admin-agents.service.ts's createAgent) and the seeded Admin get
  // phoneVerified: true set directly, same reasoning as emailVerified above.
  //
  // ADMIN is exempt outright: this gate exists only for the agent
  // self-registration flow, and Admin accounts are never provisioned through
  // it (seeded directly, or created by another Admin) - so a stale/unset
  // phoneVerified flag on an Admin row must never block that account from
  // signing in.
  if (user.role.code !== 'ADMIN' && !user.phoneVerified) throw Errors.phoneNotVerified();

  if (user.status !== 'ACTIVE') throw Errors.userSuspended();

  const session = await issueSession(user.id, user.role.code as 'USER' | 'AGENT' | 'ADMIN');

  await writeAuditLog({ userId: user.id, action: 'LOGIN', entityType: 'users', entityId: user.id });

  return { user: serializeUser(user), ...session };
}

export async function refresh(rawToken: string) {
  const tokenHash = hashRefreshToken(rawToken);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing || existing.revokedAt || existing.expiresAt < new Date()) {
    throw Errors.unauthorized('Session expired. Please sign in again.');
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: existing.userId },
    include: { role: true, agentProfile: true },
  });

  await prisma.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
  const session = await issueSession(user.id, user.role.code as 'USER' | 'AGENT' | 'ADMIN', {
    deviceId: existing.deviceId,
    platform: existing.platform,
    appVersion: existing.appVersion,
  });

  return { user: serializeUser(user), ...session };
}

export async function logout(rawToken: string | undefined) {
  if (!rawToken) return;
  const tokenHash = hashRefreshToken(rawToken);
  await prisma.refreshToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } });
}

// Same non-enumerating shape as resendVerificationEmail(): the response
// never reveals whether the account exists, so a bad actor can't use this
// endpoint to discover registered emails.
export async function forgotPassword(email: string) {
  const generic = { message: 'If an account exists for this email, a reset link has been sent.' };
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) return generic;

  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
  });

  const resetUrl = buildPasswordResetUrl(rawToken);
  await sendPasswordResetEmail(email, user.name ?? 'there', resetUrl);

  return {
    ...generic,
    // Only present outside production, and only because no real SMTP
    // credentials exist yet - see email.service.ts.
    ...(env.nodeEnv !== 'production' ? { devResetUrl: resetUrl } : {}),
  };
}

export async function resetPassword(token: string, newPassword: string) {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const user = await prisma.user.findFirst({
    where: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: { gt: new Date() } },
  });
  if (!user) throw Errors.validation('This reset link is invalid or has expired.');

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordResetTokenHash: null, passwordResetExpiresAt: null },
    }),
    prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  await writeAuditLog({ userId: user.id, action: 'PASSWORD_RESET', entityType: 'users', entityId: user.id });

  return { message: 'Password updated. Please sign in again.' };
}

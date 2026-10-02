import { randomInt, createHash } from 'node:crypto';
import { env } from '../config/env.js';

export function generateOtp(length = env.otpLength): string {
  const max = 10 ** length;
  return randomInt(0, max).toString().padStart(length, '0');
}

export function hashOtp(otp: string): string {
  return createHash('sha256').update(otp).digest('hex');
}

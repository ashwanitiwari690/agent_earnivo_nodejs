import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - avoids user transcription errors
const LENGTH = 7;

export function generateReferralCode(): string {
  let code = '';
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

export const passwordSchema = z
  .string()
  .min(8, 'Kata sandi minimal 8 karakter')
  .max(128, 'Kata sandi maksimal 128 karakter');

export const usernameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-zA-Z0-9._-]{3,32}$/,
    'Username 3–32 karakter: huruf, angka, titik, garis',
  );

export const pinSchema = z.string().regex(/^\d{6}$/, 'PIN harus 6 digit angka');

/** argon2id with the library defaults (OWASP-recommended parameters). */
export const hashSecret = (plain: string) => hash(plain);

export async function verifySecret(storedHash: string, plain: string) {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

// Verified against when the username does not exist, so both paths take similar time.
let dummyHash: Promise<string> | undefined;
export const getDummyHash = () => (dummyHash ??= hash('dummy-password'));

/**
 * Refresh token = "<sessionId>.<secret>". Only sha256(secret) is stored, so a
 * leaked sessions table cannot be replayed.
 */
export function createRefreshToken(sessionId: string) {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${sessionId}.${secret}`, secretHash: sha256(secret) };
}

export function parseRefreshToken(token: string) {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const sessionId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!z.uuid().safeParse(sessionId).success || secret.length === 0) {
    return null;
  }
  return { sessionId, secret };
}

export function secretMatches(secret: string, storedHash: string) {
  const a = Buffer.from(sha256(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

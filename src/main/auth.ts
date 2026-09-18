import * as crypto from 'crypto';

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12 hours

export interface IssuedToken {
  token: string;
  expiresAt: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function generateSecret(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** Byte-length comparison without an early bail-out — protects against timing
 * attacks when checking the pre-shared secret a client sends to /api/auth. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/** A minimal but format-compatible JWT (HS256) token with no external library —
 * we only need exp and a pre-shared-secret signature, no claims/aud/iss. */
export function issueToken(secret: string): IssuedToken {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = base64url(JSON.stringify({ exp: expiresAt }));
  const signature = sign(`${header}.${payload}`, secret);
  return { token: `${header}.${payload}.${signature}`, expiresAt };
}

export function verifyToken(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`, secret);
  if (!timingSafeEqualStr(signature, expected)) return false;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return typeof claims.exp === 'number' && claims.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

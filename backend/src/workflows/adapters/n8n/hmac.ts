import { createHmac, timingSafeEqual } from 'node:crypto';

export const HMAC_HEADER = 'x-n8n-webhook-signature';
export const SECRET_HEADER = 'x-agent-webhook-secret';
const SIG_PREFIX = 'sha256=';

/**
 * HMAC helpers — retained for outbound callbacks where the receiver owns the
 * secret. Phase 2.3 inbound webhooks use a static shared header instead
 * (see verifyStaticSecret) because n8n would otherwise need a Code node per
 * httpRequest to compute the signature, tripling node count.
 */
export function signBody(rawBody: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return `${SIG_PREFIX}${digest}`;
}

export function verifyHmac(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(SIG_PREFIX)) return false;
  const expected = signBody(rawBody, secret);
  return constantTimeEquals(expected, signatureHeader);
}

/** Inbound: compare the bearer-style shared secret in a static header. */
export function verifyStaticSecret(
  headerValue: string | undefined,
  expectedSecret: string,
): boolean {
  if (!headerValue || !expectedSecret) return false;
  return constantTimeEquals(headerValue, expectedSecret);
}

export function isFresh(timestampIso: string, skewSeconds: number, nowMs = Date.now()): boolean {
  const t = Date.parse(timestampIso);
  if (Number.isNaN(t)) return false;
  return Math.abs(nowMs - t) <= skewSeconds * 1000;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

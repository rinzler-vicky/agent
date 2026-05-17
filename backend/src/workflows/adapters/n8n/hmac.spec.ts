import { signBody, verifyHmac, verifyStaticSecret, isFresh } from './hmac';

describe('hmac module', () => {
  const secret = 'test-secret-32-chars-min-padding-aaaa';
  const body = JSON.stringify({ runId: 'r1', event: 'workflow.started', timestamp: '2026-05-17T00:00:00Z' });

  describe('HMAC outbound helpers', () => {
    it('signs deterministically', () => {
      expect(signBody(body, secret)).toBe(signBody(body, secret));
      expect(signBody(body, secret)).toMatch(/^sha256=[0-9a-f]{64}$/);
    });

    it('verifyHmac accepts a valid signature', () => {
      const sig = signBody(body, secret);
      expect(verifyHmac(body, sig, secret)).toBe(true);
    });

    it('verifyHmac rejects a mutated body', () => {
      const sig = signBody(body, secret);
      expect(verifyHmac(body + ' ', sig, secret)).toBe(false);
    });

    it('verifyHmac rejects a wrong secret', () => {
      const sig = signBody(body, secret);
      expect(verifyHmac(body, sig, 'wrong-secret')).toBe(false);
    });

    it('verifyHmac rejects a missing or malformed header', () => {
      expect(verifyHmac(body, undefined, secret)).toBe(false);
      expect(verifyHmac(body, 'nosha=abc', secret)).toBe(false);
      expect(verifyHmac(body, 'sha256=', secret)).toBe(false);
    });
  });

  describe('verifyStaticSecret', () => {
    it('accepts a matching secret', () => {
      expect(verifyStaticSecret(secret, secret)).toBe(true);
    });

    it('rejects a different secret', () => {
      expect(verifyStaticSecret('other-secret', secret)).toBe(false);
    });

    it('rejects undefined or empty values', () => {
      expect(verifyStaticSecret(undefined, secret)).toBe(false);
      expect(verifyStaticSecret('', secret)).toBe(false);
      expect(verifyStaticSecret(secret, '')).toBe(false);
    });

    it('rejects when lengths differ (no timing leak via short-circuit)', () => {
      expect(verifyStaticSecret(secret + 'x', secret)).toBe(false);
    });
  });

  describe('isFresh', () => {
    const now = Date.parse('2026-05-17T12:00:00Z');

    it('accepts within window', () => {
      expect(isFresh('2026-05-17T11:59:00Z', 300, now)).toBe(true);
      expect(isFresh('2026-05-17T12:00:00Z', 300, now)).toBe(true);
    });

    it('rejects outside window', () => {
      expect(isFresh('2026-05-17T11:54:00Z', 300, now)).toBe(false);
      expect(isFresh('2026-05-17T12:06:00Z', 300, now)).toBe(false);
    });

    it('rejects invalid timestamp', () => {
      expect(isFresh('not-a-date', 300, now)).toBe(false);
    });
  });
});

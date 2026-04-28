import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signHmacSha256, verifyHmacSignature } from './hmac.js';

const SECRET = 'test-webhook-secret';
const BODY = '{"hello":"world"}';

function sig(): string {
  return `sha256=${createHmac('sha256', SECRET).update(BODY).digest('hex')}`;
}

describe('webhooks/hmac', () => {
  it('accepts a valid sha256=<hex> signature', () => {
    expect(verifyHmacSignature(SECRET, BODY, sig())).toBe(true);
  });

  it('accepts bare hex without the sha256= prefix', () => {
    const hex = sig().slice(7);
    expect(verifyHmacSignature(SECRET, BODY, hex)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyHmacSignature(SECRET, '{"hello":"tampered"}', sig())).toBe(false);
  });

  it('rejects an incorrect secret', () => {
    expect(verifyHmacSignature('wrong-secret', BODY, sig())).toBe(false);
  });

  it('rejects null/empty headers', () => {
    expect(verifyHmacSignature(SECRET, BODY, null)).toBe(false);
    expect(verifyHmacSignature(SECRET, BODY, '')).toBe(false);
  });

  it('rejects non-hex content without throwing', () => {
    expect(verifyHmacSignature(SECRET, BODY, 'sha256=not-hex!!')).toBe(false);
  });

  it('rejects length-mismatched signatures without throwing', () => {
    expect(verifyHmacSignature(SECRET, BODY, 'sha256=abcd')).toBe(false);
  });

  it('signHmacSha256 returns the expected canonical prefix + hex', () => {
    const out = signHmacSha256(SECRET, BODY);
    expect(out).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyHmacSignature(SECRET, BODY, out)).toBe(true);
  });
});

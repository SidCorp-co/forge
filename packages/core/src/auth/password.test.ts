import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password', () => {
  it('hashPassword returns an argon2id PHC string', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('produces a different hash each call (random salt)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
  });

  it('verifyPassword returns true for the correct password', async () => {
    const hash = await hashPassword('s3cret!');
    expect(await verifyPassword('s3cret!', hash)).toBe(true);
  });

  it('verifyPassword returns false for the wrong password', async () => {
    const hash = await hashPassword('s3cret!');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('verifyPassword returns false (no throw) on a malformed hash', async () => {
    expect(await verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
  });

  it('hashPassword completes in a reasonable time', async () => {
    const start = performance.now();
    await hashPassword('perf-check');
    const elapsed = performance.now() - start;
    // AC target is <200ms on a 2-core production CPU; CI runners are slower.
    // 2000ms is a generous upper bound to catch pathological regressions.
    expect(elapsed).toBeLessThan(2000);
  });
});

import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const { holdsKey } = await import('./held-key.js');

function sealedUnderAnotherKey(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('holdsKey', () => {
  it('reads a record this key cannot open as holding one, not as holding none', () => {
    const row = { provider: 'postman', secretsEnc: sealedUnderAnotherKey('{"apiKey":"x"}') };
    expect(holdsKey(row)).toBe(true);
  });

  it('lets a fault that is not an unreadable record surface as itself', async () => {
    vi.resetModules();
    vi.stubEnv('INTEGRATION_MASTER_KEY', 'bm90LWEta2V5');
    const fresh = await import('./held-key.js');
    const row = { provider: 'postman', secretsEnc: sealedUnderAnotherKey('{"apiKey":"x"}') };
    expect(() => fresh.holdsKey(row)).toThrow(
      /INTEGRATION_MASTER_KEY: base64 must decode to 32 bytes/,
    );
  });
});

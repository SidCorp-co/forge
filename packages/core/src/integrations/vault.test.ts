import { createCipheriv, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

let vault: typeof import('./vault.js');

beforeAll(async () => {
  vault = await import('./vault.js');
});

const PLAIN = 'made-up-secret-never-to-be-shown';

function sealedUnderAnotherKey(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a throw and none came');
}

describe('decryptSecret on a value this key cannot open', () => {
  it('raises SecretUnreadableError for a value sealed under another key', () => {
    const sealed = sealedUnderAnotherKey(PLAIN);
    const err = thrownBy(() => vault.decryptSecret(sealed));
    expect(err).toBeInstanceOf(vault.SecretUnreadableError);
    expect(err.message).toBe("the stored value is not one this server's key opens");
  });

  it('raises it for a value of this key whose bytes were damaged', () => {
    const sealed = vault.encryptSecret(PLAIN);
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0xff;
    expect(thrownBy(() => vault.decryptSecret(sealed))).toBeInstanceOf(vault.SecretUnreadableError);
  });

  it('raises it for a value too short to be a sealed one', () => {
    const err = thrownBy(() => vault.decryptSecret(Buffer.from('x')));
    expect(err).toBeInstanceOf(vault.SecretUnreadableError);
    expect(err.message).toBe('the stored value is too short to be a sealed one');
  });

  it('says nothing of the value, the key or the plaintext', () => {
    const sealed = sealedUnderAnotherKey(PLAIN);
    const err = thrownBy(() => vault.decryptSecret(sealed));
    const said = `${err.message} ${String(err.cause ?? '')}`;
    expect(said).not.toContain(PLAIN);
    expect(said).not.toContain(sealed.toString('hex'));
    expect(said).not.toContain(sealed.toString('base64'));
    expect(said).not.toContain(process.env.INTEGRATION_MASTER_KEY as string);
    expect(said).not.toMatch(/Unsupported state|unable to authenticate/);
  });

  it('still opens a value this key sealed', () => {
    expect(vault.decryptSecret(vault.encryptSecret(PLAIN))).toBe(PLAIN);
  });
});

describe('decryptSecretIfReadable', () => {
  it('answers null for a value this key cannot open', () => {
    expect(vault.decryptSecretIfReadable(sealedUnderAnotherKey(PLAIN))).toBeNull();
  });

  it('opens a value this key sealed', () => {
    expect(vault.decryptSecretIfReadable(vault.encryptSecret(PLAIN))).toBe(PLAIN);
  });

  it('throws a fault that is not an unreadable value as itself', async () => {
    vi.resetModules();
    vi.stubEnv('INTEGRATION_MASTER_KEY', 'bm90LWEta2V5');
    try {
      const fresh = await import('./vault.js');
      expect(() => fresh.decryptSecretIfReadable(sealedUnderAnotherKey(PLAIN))).toThrow(
        /INTEGRATION_MASTER_KEY: base64 must decode to 32 bytes/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

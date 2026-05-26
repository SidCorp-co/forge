import { describe, expect, it } from 'vitest';

// 32 bytes, base64 encoded. Fixed across the file so the test is deterministic.
const TEST_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

process.env.INTEGRATION_MASTER_KEY = TEST_KEY_B64;

const { encryptSecret, decryptSecret, encryptJson, decryptJson } = await import('./vault.js');

describe('integration vault — AES-256-GCM', () => {
  it('round-trips a UTF-8 string', () => {
    const plain = 'coolify-token-abc-123';
    const enc = encryptSecret(plain);
    expect(enc.length).toBeGreaterThan(plain.length);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const plain = 'same-input';
    const a = encryptSecret(plain);
    const b = encryptSecret(plain);
    expect(Buffer.compare(a, b)).not.toBe(0);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it('round-trips JSON', () => {
    const obj = { apiToken: 'tok', previousApiToken: 'old', meta: [1, 2, 3] };
    const enc = encryptJson(obj);
    expect(decryptJson(enc)).toEqual(obj);
  });

  it('rejects tampered ciphertext (auth tag mismatch)', () => {
    const enc = encryptSecret('secret');
    // Flip one byte in the ciphertext body (past iv:12 + tag:16).
    const tampered = Buffer.from(enc);
    tampered[28] = tampered[28] ^ 0xff;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('rejects too-short buffers', () => {
    expect(() => decryptSecret(Buffer.from('shorty'))).toThrow(/too short/);
  });
});

import { describe, expect, it } from 'vitest';
import { derivePublicFromPrivate, generateSshKeypair } from './ssh-keys.js';

// Exercises the real `ssh-keygen` so the on-disk format the runner writes is
// exactly what OpenSSH/git expects. Skips nothing — these run in CI where
// ssh-keygen is present (openssh-client is standard on the runners).

describe('ssh-keys', () => {
  it('generates a valid ed25519 OpenSSH keypair', async () => {
    const k = await generateSshKeypair('forge-test');
    expect(k.publicKey.startsWith('ssh-ed25519 ')).toBe(true);
    expect(k.publicKey).toContain('forge-test');
    expect(k.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(k.fingerprint).not.toBeNull();
    expect(k.fingerprint?.startsWith('SHA256:')).toBe(true);
  });

  it('produces a different key on each call', async () => {
    const a = await generateSshKeypair('forge-test');
    const b = await generateSshKeypair('forge-test');
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('derives the public key + fingerprint from a private key (round-trip)', async () => {
    const gen = await generateSshKeypair('forge-test');
    const derived = await derivePublicFromPrivate(gen.privateKey, 'forge-relabel');
    // Same key material → same fingerprint, regardless of comment.
    expect(derived.fingerprint).toBe(gen.fingerprint);
    expect(derived.publicKey.startsWith('ssh-ed25519 ')).toBe(true);
    expect(derived.publicKey).toContain('forge-relabel');
  });

  it('rejects a malformed private key', async () => {
    await expect(derivePublicFromPrivate('not a real key', 'x')).rejects.toThrow(
      /invalid_private_key/,
    );
  });
});

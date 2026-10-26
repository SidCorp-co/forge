import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { providerHalfRefused } from '../provider-schemas.js';
import { githubSecretsSchema } from './schemas.js';

const app = (privateKey: string) => ({
  appId: '12345',
  privateKey,
  webhookSecret: 'a-webhook-secret',
});

const refusal = (privateKey: string): string | null => {
  const parsed = githubSecretsSchema.safeParse(app(privateKey));
  if (parsed.success) return null;
  // The words every save door answers with, the field path included where the schema leaves it.
  return providerHalfRefused(parsed.error, githubSecretsSchema, 'secrets', app(privateKey)).message;
};

// The shape GitHub gives an App's key in: PKCS#1, "BEGIN RSA PRIVATE KEY".
const { privateKey: PEM, publicKey: PUBLIC_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// ISS-1421 r29: `.min(100)` was worded "The field privateKey takes at least 100 characters."
describe('githubSecretsSchema — the App private key a save door takes', () => {
  it('takes a whole key', () => {
    expect(refusal(PEM)).toBeNull();
  });

  it('takes the same key as PKCS#8, "BEGIN PRIVATE KEY"', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(refusal(privateKey)).toBeNull();
  });

  // ISS-1421 r30, judge-122: a PEM cut off with no END line and 150 characters of no key at all were
  // both saved 201, the key judged by its length alone.
  it.each([
    ['nothing', ''],
    ['the BEGIN line alone', '-----BEGIN RSA PRIVATE KEY-----'],
    ['a key cut off before its END line', PEM.slice(0, 1000)],
    ['150 characters that are no key', 'k'.repeat(150)],
    ['a public key', PUBLIC_PEM],
    ['a key whose body was altered', PEM.replace(/\n[A-Za-z0-9+/]{20}/, `\n${'!'.repeat(20)}`)],
  ])('refuses %s as not a whole key, naming no field and no count', (_what, sent) => {
    const said = refusal(sent);
    expect(said).toMatch(/^This is not a whole GitHub App private key/);
    expect(said).not.toContain('privateKey');
    expect(said).not.toMatch(/characters|\d{3,}/);
  });

  // ISS-1421 r31, judge-127: a whole key indented as a YAML or JSON block carries it was refused as
  // not whole, and a key stored with its indent is one the App's token mint cannot read.
  it.each([
    ['two spaces', '  '],
    ['a tab', '\t'],
  ])(
    'takes a whole key indented by %s on every line, and keeps it without the indent',
    (_what, indent) => {
      const indented = PEM.trimEnd()
        .split('\n')
        .map((line) => `${indent}${line}`)
        .join('\n');
      const parsed = githubSecretsSchema.safeParse(app(indented));
      expect(parsed.success).toBe(true);
      expect(parsed.data?.privateKey).toBe(PEM.trim());
    },
  );

  it('refuses more than any App key as that, with no count', () => {
    const said = refusal(`${PEM}${'x'.repeat(20000)}`);
    expect(said).toMatch(/^This is larger than any private key GitHub gives an App/);
    expect(said).not.toContain('privateKey');
    expect(said).not.toMatch(/\d{3,}/);
  });
});

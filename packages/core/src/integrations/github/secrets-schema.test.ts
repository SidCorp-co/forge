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

const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(120)}\n-----END RSA PRIVATE KEY-----\n`;

// ISS-1421 r29: `.min(100)` was worded "The field privateKey takes at least 100 characters."
describe('githubSecretsSchema — the App private key a save door takes', () => {
  it('takes a whole key', () => {
    expect(refusal(PEM)).toBeNull();
  });

  it.each([
    ['nothing', ''],
    ['the BEGIN line alone', '-----BEGIN RSA PRIVATE KEY-----'],
  ])('refuses %s as not a whole key, naming no field and no count', (_what, sent) => {
    const said = refusal(sent);
    expect(said).toMatch(/^This is not a whole GitHub App private key/);
    expect(said).not.toContain('privateKey');
    expect(said).not.toMatch(/characters|\d{3,}/);
  });

  it('refuses more than any App key as that, with no count', () => {
    const said = refusal(`${PEM}${'x'.repeat(20000)}`);
    expect(said).toMatch(/^This is larger than any private key GitHub gives an App/);
    expect(said).not.toContain('privateKey');
    expect(said).not.toMatch(/\d{3,}/);
  });
});

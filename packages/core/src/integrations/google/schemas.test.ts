import { describe, expect, it } from 'vitest';
import { googleSecretsSchema } from './schemas.js';

const keyFile = (extra: Record<string, unknown>) =>
  JSON.stringify({
    type: 'service_account',
    client_email: 'reader@example-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
    ...extra,
  });

const refusal = (serviceAccountJson: string) => {
  const parsed = googleSecretsSchema.safeParse({ serviceAccountJson });
  return parsed.success ? null : parsed.error.issues.map((i) => i.message).join(' ');
};

describe('googleSecretsSchema — the key file a save door takes', () => {
  it('takes a whole key file naming Google’s token endpoint, or none', () => {
    expect(refusal(keyFile({ token_uri: 'https://oauth2.googleapis.com/token' }))).toBeNull();
    expect(refusal(keyFile({}))).toBeNull();
  });

  // ISS-1421 r27: a whole key file naming another endpoint was refused as no key file at all.
  it('refuses a key file whose token_uri is not Google’s for its token_uri', () => {
    const said = refusal(keyFile({ token_uri: 'https://tokens.example.com/token' }));
    expect(said).toMatch(/^This key file's "token_uri" is not Google's /);
    expect(said).not.toContain('serviceAccountJson');
    expect(said).not.toContain('not the whole service-account key file');
  });

  it('still refuses what is not a key file as not a key file', () => {
    const said = refusal(JSON.stringify({ type: 'authorized_user', padding: 'x'.repeat(120) }));
    expect(said).toMatch(/^This is not the whole service-account key file Google issued/);
    expect(said).not.toContain('serviceAccountJson');
  });
});

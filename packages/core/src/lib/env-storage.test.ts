import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Env, S3_SETTINGS, storageEnvIssues } from './env.js';

const S3_ENV = {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://s3.example.test',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'shared-bucket',
  S3_PREFIX: 'forge-dev/',
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: 'unit-access-key',
  S3_SECRET_ACCESS_KEY: 'unit-secret-key',
} as const;

const parsed = (over: Partial<Env>) =>
  ({ ...S3_ENV, S3_FORCE_PATH_STYLE: true, ...over }) as unknown as Env;

/** Loads `lib/env.ts` fresh under `vars`, the way core reads its environment at boot. */
async function boot(vars: Record<string, string | undefined>): Promise<unknown> {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  const { env } = await import('./env.js');
  return env.STORAGE_DRIVER;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('STORAGE_DRIVER=s3: refused at boot naming each missing S3_* setting (ISS-1364)', () => {
  it('boots with every s3 setting present', async () => {
    await expect(boot(S3_ENV)).resolves.toBe('s3');
    expect(storageEnvIssues(parsed({}))).toEqual([]);
  });

  it('refuses a boot whose S3_BUCKET is unset, naming it and no other setting', async () => {
    await expect(boot({ ...S3_ENV, S3_BUCKET: undefined })).rejects.toThrow(
      /Invalid environment:\n {2}- S3_BUCKET: required when STORAGE_DRIVER=s3; it is unset$/,
    );
  });

  it('names every missing setting, one line each, and never prints a value it holds', () => {
    const lines = storageEnvIssues(
      parsed({ S3_ENDPOINT: undefined, S3_PREFIX: undefined, S3_SECRET_ACCESS_KEY: undefined }),
    );
    expect(lines.map((l) => l.split(':')[0]?.trim())).toEqual([
      '- S3_ENDPOINT',
      '- S3_PREFIX',
      '- S3_SECRET_ACCESS_KEY',
    ]);
    expect(lines.join('\n')).not.toContain(S3_ENV.S3_ACCESS_KEY_ID);
    const none = Object.fromEntries(S3_SETTINGS.map((n) => [n, undefined]));
    expect(storageEnvIssues(parsed(none))).toHaveLength(S3_SETTINGS.length);
  });

  it('asks nothing of the local driver, the default', async () => {
    expect(storageEnvIssues(parsed({ STORAGE_DRIVER: 'local', S3_BUCKET: undefined }))).toEqual([]);
    await expect(boot({ STORAGE_DRIVER: undefined })).resolves.toBe('local');
  });

  it('refuses a prefix that leaves its folder, and a path-style flag that is no boolean', async () => {
    await expect(boot({ ...S3_ENV, S3_PREFIX: '/forge-dev' })).rejects.toThrow(/S3_PREFIX/);
    await expect(boot({ ...S3_ENV, S3_PREFIX: 'a/../b' })).rejects.toThrow(/S3_PREFIX/);
    await expect(boot({ ...S3_ENV, S3_FORCE_PATH_STYLE: 'yes' })).rejects.toThrow(
      /S3_FORCE_PATH_STYLE must be one of true, false, 1, 0; got "yes"/,
    );
  });
});

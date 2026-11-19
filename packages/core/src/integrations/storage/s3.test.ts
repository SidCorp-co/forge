import { describe, expect, it } from 'vitest';
import { S3Storage, s3SettingsFrom } from './s3.js';

const settings = s3SettingsFrom({
  S3_ENDPOINT: 'http://127.0.0.1:9',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'shared',
  S3_PREFIX: 'forge-dev',
  S3_FORCE_PATH_STYLE: true,
  S3_ACCESS_KEY_ID: 'unit',
  S3_SECRET_ACCESS_KEY: 'unit',
});
const storage = new S3Storage(settings, '/app/uploads');

describe('S3Storage keeps every key under S3_PREFIX (ISS-1364)', () => {
  it('reads a prefix with or without its trailing slash as one folder', () => {
    expect(settings.prefix).toBe('forge-dev/');
    expect(storage.objectKey('issues/1/a.png')).toBe('forge-dev/issues/1/a.png');
  });

  it('resolves its own s3:// path and a local-driver row under UPLOADS_DIR to the same key', () => {
    expect(storage.locate('s3://shared/forge-dev/issues/1/a.png')).toBe('forge-dev/issues/1/a.png');
    expect(storage.locate('/app/uploads/issues/1/a.png')).toBe('forge-dev/issues/1/a.png');
  });

  it('refuses a key or a path that would land outside the prefix, by name', () => {
    expect(() => storage.objectKey('../agenfold-dev/x')).toThrow(
      /storage key "..\/agenfold-dev\/x"/,
    );
    expect(() => storage.objectKey('/abs')).toThrow(/not a relative path/);
    expect(() => storage.locate('s3://shared/agenfold-dev/x')).toThrow(
      /outside s3:\/\/shared\/forge-dev\//,
    );
    expect(() => storage.locate('s3://other/forge-dev/x')).toThrow(/outside s3:\/\/shared/);
    expect(() => storage.locate('/srv/elsewhere/x')).toThrow(/neither an s3:\/\/ path nor a file/);
    expect(() => storage.locate('relative/x')).toThrow(/neither an s3:\/\/ path nor a file/);
  });

  it('refuses settings with one unset, naming it', () => {
    expect(() =>
      s3SettingsFrom({
        S3_ENDPOINT: 'http://127.0.0.1:9',
        S3_REGION: 'us-east-1',
        S3_BUCKET: undefined,
        S3_PREFIX: 'p',
        S3_FORCE_PATH_STYLE: false,
        S3_ACCESS_KEY_ID: 'a',
        S3_SECRET_ACCESS_KEY: 'b',
      }),
    ).toThrow('the s3 storage driver needs S3_BUCKET, which are unset');
  });
});

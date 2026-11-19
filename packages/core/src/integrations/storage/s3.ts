import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { type Env, s3SettingIssues } from '../../lib/env.js';
import type { StorageAdapter } from './types.js';

/** What the s3 driver connects with: an S3-compatible server, one bucket, one folder in it. */
export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  /** Normalised to end in `/`, so `forge-dev` and `forge-dev/` name one folder. */
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

type S3Env = Pick<
  Env,
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_PREFIX'
  | 'S3_FORCE_PATH_STYLE'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
>;

/** The s3 settings of `parsed`, refused naming each one unset (boot refuses the same, `lib/env.ts:storageEnvIssues`). */
export function s3SettingsFrom(parsed: S3Env): S3Settings {
  const issues = s3SettingIssues(parsed);
  const {
    S3_ENDPOINT: endpoint,
    S3_REGION: region,
    S3_BUCKET: bucket,
    S3_PREFIX: prefix,
    S3_FORCE_PATH_STYLE: style,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
  } = parsed;
  if (
    issues.length > 0 ||
    endpoint === undefined ||
    region === undefined ||
    bucket === undefined ||
    prefix === undefined ||
    style === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    throw new Error(`the s3 storage driver cannot start:\n${issues.join('\n')}`);
  }
  const forcePathStyle = style === 'true' || style === '1';
  return {
    endpoint,
    region,
    bucket,
    prefix: prefix.endsWith('/') ? prefix : `${prefix}/`,
    forcePathStyle,
    accessKeyId,
    secretAccessKey,
  };
}

/** A read of a key the bucket does not hold answers as a missing file does, so callers' 404s hold. */
function missingObject(path: string): Error {
  return Object.assign(new Error(`no object is stored at ${path}`), { code: 'ENOENT' });
}

function isNoSuchKey(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Uploads in one bucket, every key under one prefix (ISS-1364). `put` answers `s3://<bucket>/<object
 * key>`. A row written by the local driver holds an absolute path under UPLOADS_DIR; the migration
 * (`migrate-uploads.ts`) copied that file to the same key under the prefix, so such a path reads too.
 */
export class S3Storage implements StorageAdapter {
  private readonly client: S3Client;
  private readonly uploadsRoot: string;

  constructor(
    private readonly settings: S3Settings,
    uploadsRoot: string,
  ) {
    this.uploadsRoot = resolve(uploadsRoot);
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
      // An S3-compatible server need not take the SDK's default CRC checksum headers; send them only
      // where the operation requires one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /** The object key `key` is stored at: the prefix, then the key, which may not climb out of it. */
  objectKey(key: string): string {
    const parts = key.split('/');
    if (key === '' || key.startsWith('/') || parts.includes('..') || key.includes('\\')) {
      throw new Error(
        `storage key "${key}" is not a relative path inside the uploads folder (no leading '/', no '..', no '\\')`,
      );
    }
    return `${this.settings.prefix}${key}`;
  }

  /** The object key a stored path names, refused by name when it is no path this driver stores. */
  locate(path: string): string {
    const own = `s3://${this.settings.bucket}/${this.settings.prefix}`;
    if (path.startsWith('s3://')) {
      if (!path.startsWith(own)) {
        throw new Error(
          `stored path ${path} is outside s3://${this.settings.bucket}/${this.settings.prefix}, the S3_BUCKET and S3_PREFIX this core stores under`,
        );
      }
      return this.objectKey(path.slice(own.length));
    }
    const rel = isAbsolute(path) ? relative(this.uploadsRoot, path) : '..';
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `stored path ${path} is neither an s3:// path nor a file under UPLOADS_DIR ${this.uploadsRoot}`,
      );
    }
    return this.objectKey(rel.split(sep).join('/'));
  }

  async put(key: string, data: Buffer | Uint8Array, mime: string): Promise<{ path: string }> {
    const objectKey = this.objectKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: objectKey,
        Body: data,
        ContentType: mime,
        ContentLength: data.byteLength,
      }),
    );
    return { path: `s3://${this.settings.bucket}/${objectKey}` };
  }

  async get(path: string): Promise<Buffer> {
    const objectKey = this.locate(path);
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.settings.bucket, Key: objectKey }),
      );
      if (out.Body === undefined) throw missingObject(path);
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (err) {
      if (isNoSuchKey(err)) throw missingObject(path);
      throw err;
    }
  }

  /** S3 answers a delete of a key it does not hold as done, as the local driver does a missing file. */
  async delete(path: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: this.locate(path) }),
    );
  }

  /** Every object under the prefix with its size, keyed as `put` was given it. */
  async sizes(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.settings.bucket,
          Prefix: this.settings.prefix,
          ContinuationToken: token,
        }),
      );
      for (const o of page.Contents ?? []) {
        if (o.Key === undefined) continue;
        out.set(o.Key.slice(this.settings.prefix.length), o.Size ?? 0);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return out;
  }

  /** Where this driver stores, for a report: `s3://<bucket>/<prefix>`. */
  describe(): string {
    return `s3://${this.settings.bucket}/${this.settings.prefix}`;
  }
}

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { CreateBucketCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { containerName, freePort } from './postgres-container.js';

/** An S3-compatible server for the storage driver's tests (ISS-1364), pinned like the Postgres image. */
export const MINIO_IMAGE = 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z';

export interface StartedMinio {
  name: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  client: S3Client;
}

function docker(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.error) {
    throw new Error(
      `the storage test could not run docker (${r.error.message}): it boots a throwaway MinIO ` +
        'in a container and needs a docker daemon this user can reach.',
    );
  }
  return { status: r.status, stderr: r.stderr };
}

async function answering(client: S3Client, name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await client.send(new ListBucketsCommand({}));
      return;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`${name} did not answer S3 within ${timeoutMs}ms: ${String(err)}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Boots a MinIO the test file owns outright, holding `buckets`: its own name, port and keys. */
export async function startMinio(buckets: string[], timeoutMs = 60_000): Promise<StartedMinio> {
  const name = `${containerName()}-minio`;
  const port = await freePort();
  const accessKeyId = `it${randomBytes(6).toString('hex')}`;
  const secretAccessKey = randomBytes(16).toString('hex');
  const run = docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:9000`,
    '-e',
    `MINIO_ROOT_USER=${accessKeyId}`,
    '-e',
    `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
    MINIO_IMAGE,
    'server',
    '/data',
  ]);
  if (run.status !== 0) {
    throw new Error(`docker run ${name} on 127.0.0.1:${port} failed: ${run.stderr.trim()}`);
  }
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  try {
    await answering(client, name, timeoutMs);
    for (const bucket of buckets) await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    stopMinio(name);
    throw err;
  }
  return { name, endpoint, accessKeyId, secretAccessKey, client };
}

/** Removes the container and its anonymous volume by the name this file gave it. */
export function stopMinio(name: string): void {
  const r = docker(['rm', '-f', '-v', name]);
  if (r.status !== 0 && !/No such container/i.test(r.stderr)) {
    throw new Error(`docker rm ${name} failed: ${r.stderr.trim()}`);
  }
}

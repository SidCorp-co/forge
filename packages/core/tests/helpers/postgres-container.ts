import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import postgres from 'postgres';

export const IMAGE = 'pgvector/pgvector:pg17';

/** Host ports a run never binds: the long-lived databases on a shared box answer there. */
export const RESERVED_PORTS: ReadonlySet<number> = new Set([5432, 5433, 3306, 3307, 3317]);

export interface StartedPostgres {
  name: string;
  port: number;
  adminUrl: string;
}

function docker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.error) {
    throw new Error(
      `the integration suite could not run docker (${r.error.message}). This is an ENVIRONMENT ` +
        'condition, not a failure of the code under test: the suite boots a throwaway Postgres ' +
        'in a container and needs a docker daemon this user can reach.',
    );
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A port the kernel just handed out and nothing holds, refused when it is one a box reserves. */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const chosen = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(chosen));
      });
    });
    if (port > 0 && !RESERVED_PORTS.has(port)) return port;
  }
  throw new Error('the kernel handed out no usable free port in 5 attempts');
}

/** `forge-qa-<lane>-<pid>`: the lane is the checkout's branch, so two worktrees never share one. */
export function containerName(pid: number = process.pid): string {
  const env = process.env.FORGE_QA_LANE;
  const branch =
    env !== undefined && env !== ''
      ? env
      : spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const lane = (branch || 'local')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 40);
  return `forge-qa-${lane}-${pid}`;
}

async function answers(url: string): Promise<boolean> {
  const client = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await client`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/** Boots a Postgres the run owns outright: its own name, its own port, and gone at teardown. */
export async function startPostgres(timeoutMs = 60_000): Promise<StartedPostgres> {
  const name = containerName();
  const port = await freePort();
  const password = randomBytes(12).toString('hex');
  const run = docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:5432`,
    '-e',
    'POSTGRES_USER=forge',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_DB=forge_admin',
    IMAGE,
    '-c',
    'fsync=off',
    '-c',
    'full_page_writes=off',
    '-c',
    'synchronous_commit=off',
    '-c',
    'max_connections=400',
  ]);
  if (run.status !== 0) {
    throw new Error(`docker run ${name} on 127.0.0.1:${port} failed: ${run.stderr.trim()}`);
  }
  const started: StartedPostgres = {
    name,
    port,
    adminUrl: `postgres://forge:${password}@127.0.0.1:${port}/forge_admin`,
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await answers(started.adminUrl)) return started;
    await new Promise((r) => setTimeout(r, 250));
  }
  stopPostgres(name);
  throw new Error(`${name} did not accept a connection within ${timeoutMs}ms`);
}

/** Removes the container by the name this run gave it; a name already gone is not an error. */
export function stopPostgres(name: string): void {
  const r = docker(['rm', '-f', '-v', name]);
  if (r.status !== 0 && !/No such container/i.test(r.stderr)) {
    throw new Error(`docker rm ${name} failed: ${r.stderr.trim()}`);
  }
}

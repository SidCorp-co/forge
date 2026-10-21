import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { expect } from 'vitest';

import { notFoundHandler } from '../../src/middleware/error.js';
import type { RequestIdVars } from '../../src/middleware/request-id.js';

// The box the served install script runs on in `src/devices/install-routes.test.ts`: the install
// routes on loopback over a scratch RUNNER_RELEASE_DIR, the ways a server or a network can answer
// badly, and a runner of the script itself — `sh`, `curl`, `sha256sum` for real, with a scratch
// HOME and a `uname` shim choosing the platform it believes it is on.

export const BUILD = '#!/bin/sh\necho "forge-runner 9.9.9-test $*"\n';
export const PUBLISHED = 'x86_64-unknown-linux-gnu';
/** The limits the served script sets on each request, in seconds. */
export const LIMITS = { connect: 30, stall: 30 };
/** Any run still going after this is killed, so no case can hang the suite. */
const DEADLINE_MS = 12_000;

/** How the build download misbehaves, if it does. */
export type DownloadFault =
  /** A byte added on the way, as a proxy or a corrupted transfer would. */
  | 'tamper'
  /** The download failing outright, as a proxy timing out or core restarting would: HTTP 502. */
  | 'bad-gateway'
  /** The connection dropping mid-download, as a box losing its network would see: no answer. */
  | 'dropped'
  /** Headers and a first byte, then nothing, with the connection held open. */
  | 'stalled'
  /** The build arriving slowly but steadily, a byte at a time over about three seconds. */
  | 'slow'
  | null;

export interface Install {
  code: number | null;
  stdout: string;
  stderr: string;
  home: string;
  bin: string;
  /** How long the script ran, and whether the world had to kill it at its deadline. */
  ms: number;
  killed: boolean;
}

export interface InstallOptions {
  /** A build already installed on the box before the script runs. */
  existing?: string;
  /** Stand in for the core the script was served by, as a box that cannot reach it would see. */
  servedBy?: { base: string; prefix: string };
  /** Run the script with shorter request limits, so a stall is refused inside a test's time. */
  limits?: { connect: number; stall: number };
}

export interface InstallWorld {
  root: string;
  releaseDir: string;
  /** Where the install routes answer, mounted under `/api` as the running app mounts them. */
  base: string;
  /** A loopback port nothing listens on: the build list there is unreachable. */
  closedPort: number;
  /** A loopback server that accepts every connection and never answers on it. */
  quietBase: string;
  download: DownloadFault;
  /** Run the served install script as a box reporting `os`/`arch` would. */
  install(name: string, os: string, arch: string, options?: InstallOptions): Promise<Install>;
  close(): Promise<void>;
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const octets = { 'content-type': 'application/octet-stream' };

/**
 * `routes` loads the install routes: published-build.ts reads RUNNER_RELEASE_DIR once, when it is
 * first imported, so the world sets it before the load.
 */
export async function installWorld(routes: () => Promise<Hono>): Promise<InstallWorld> {
  const root = await mkdtemp(join(tmpdir(), 'install-routes-'));
  const releaseDir = join(root, 'release');
  await mkdir(releaseDir);
  await writeFile(join(releaseDir, `forge-runner-${PUBLISHED}`), BUILD);
  await writeFile(join(releaseDir, 'VERSION'), '9.9.9-test\n');
  await writeFile(join(releaseDir, 'COMMIT'), `${'a'.repeat(40)}\n`);
  process.env.RUNNER_RELEASE_DIR = releaseDir;
  const installRoutes = await routes();

  // Typed as core's app is, so core's own notFoundHandler fits it.
  const app = new Hono<{ Variables: RequestIdVars }>();
  app.use('/api/install/bin/*', async (c, next) => {
    switch (w.download) {
      case 'tamper': {
        // Core still publishes the sha256 of the build it holds; the download no longer matches it.
        await next();
        const body = new Uint8Array(await c.res.arrayBuffer());
        const changed = new Uint8Array(body.length + 1);
        changed.set(body);
        changed[body.length] = 0x58;
        c.res = new Response(changed, { status: c.res.status, headers: c.res.headers });
        return;
      }
      case 'bad-gateway':
        return c.text('bad gateway', 502);
      case 'dropped':
        (c.env as { incoming: { socket: { destroy(): void } } }).incoming.socket.destroy();
        return new Response(null);
      case 'stalled':
        return new Response(
          new ReadableStream<Uint8Array>({ start: (ctl) => ctl.enqueue(new Uint8Array([0x23])) }),
          { status: 200, headers: octets },
        );
      case 'slow': {
        const bytes = new TextEncoder().encode(BUILD);
        let i = 0;
        const body = new ReadableStream<Uint8Array>({
          pull: async (ctl) => {
            await new Promise((resolve) => setTimeout(resolve, 3_000 / bytes.length));
            if (i < bytes.length) ctl.enqueue(bytes.subarray(i, ++i));
            else ctl.close();
          },
        });
        return new Response(body, { status: 200, headers: octets });
      }
      default:
        return next();
    }
  });
  app.route('/api', installRoutes);
  // Core answers a path it does not serve with its own problem body, as the running app does.
  app.notFound(notFoundHandler);
  // Something that answers 200 at the build list's path but is not core: a captive portal, or a
  // web host serving its index page for every path.
  app.get('/portal/install/latest.json', (c) =>
    c.html('<html><body>Sign in to continue</body></html>'),
  );
  // A proxy in front of core answering with its own error page rather than core's reason.
  app.get('/maintenance/install/latest.json', (c) =>
    c.html('<html><body>Down for maintenance</body></html>', 503),
  );
  // A JSON reason holding an escaped quote and backslashes, as JSON.stringify writes them.
  app.get('/quoted/install/latest.json', (c) =>
    c.json({ code: 'CORE_SAID', error: 'core said "stop" at C:\\forge\\new here' }, 500),
  );

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const held = new Set<Socket>();
  const quiet = createServer((socket) => {
    held.add(socket);
    socket.on('close', () => held.delete(socket));
  });
  await new Promise<void>((resolve) => quiet.listen(0, '127.0.0.1', () => resolve()));
  const quietBase = `http://127.0.0.1:${(quiet.address() as AddressInfo).port}`;

  async function install(
    name: string,
    os: string,
    arch: string,
    { existing, servedBy, limits }: InstallOptions = {},
  ): Promise<Install> {
    const box = join(root, name);
    const home = join(box, 'home');
    const shim = join(box, 'shim');
    const scratch = join(box, 'tmp');
    await mkdir(home, { recursive: true });
    await mkdir(scratch, { recursive: true });
    await mkdir(shim, { recursive: true });
    const uname = `#!/bin/sh\ncase "$1" in -s) echo "${os}";; -m) echo "${arch}";; *) exit 1;; esac\n`;
    await writeFile(join(shim, 'uname'), uname);
    await chmod(join(shim, 'uname'), 0o755);
    const bin = join(home, '.local', 'bin', 'forge-runner');
    if (existing !== undefined) {
      await mkdir(join(home, '.local', 'bin'), { recursive: true });
      await writeFile(bin, existing);
    }
    let script = await (await fetch(`${base}/api/install.sh`)).text();
    const swaps: [string, string][] = [];
    if (servedBy) {
      swaps.push([`BASE="${base}"`, `BASE="${servedBy.base}"`]);
      swaps.push(['PREFIX="/api"', `PREFIX="${servedBy.prefix}"`]);
    }
    if (limits) {
      swaps.push([`connect_limit=${LIMITS.connect}`, `connect_limit=${limits.connect}`]);
      swaps.push([`stall_limit=${LIMITS.stall}`, `stall_limit=${limits.stall}`]);
    }
    for (const [line, value] of swaps) {
      if (!script.includes(line)) throw new Error(`the served script no longer carries ${line}`);
      script = script.replace(line, value);
    }
    await writeFile(join(box, 'install.sh'), script);
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(box, 'config'),
      TMPDIR: scratch,
      PATH: `${shim}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    };
    const run = await new Promise<Install>((resolve, reject) => {
      const started = Date.now();
      // Its own process group, so the deadline reaches the curl the script is waiting on too.
      const child = spawn('sh', [join(box, 'install.sh')], { env, detached: true });
      let stdout = '';
      let stderr = '';
      let killed = false;
      const deadline = setTimeout(() => {
        killed = true;
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      }, DEADLINE_MS);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(deadline);
        resolve({ code, stdout, stderr, home, bin, ms: Date.now() - started, killed });
      });
    });
    // Whatever the script fetched it fetched into its own scratch, and it removes that on every exit.
    expect(await readdir(scratch)).toEqual([]);
    return run;
  }

  const w: InstallWorld = {
    root,
    releaseDir,
    base,
    closedPort,
    quietBase,
    download: null,
    install,
    close: async () => {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => quiet.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
  return w;
}

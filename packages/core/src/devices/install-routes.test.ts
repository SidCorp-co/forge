// @gate-input whole-tree — it runs the served install script under sh, which the guard cannot see
// into; the script reads only this file's scratch directory and the routes on loopback.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ServerType, serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// REQ-25: the install command Forge serves fetches the published build for the box's platform,
// refuses a build whose sha256 is not the published one, and refuses by name a platform with no
// build. The served script runs here for real — `sh`, `curl`, `sha256sum` — against these routes
// on loopback, with a scratch HOME and a `uname` shim choosing the platform it believes it is on.

const BUILD = '#!/bin/sh\necho "forge-runner 9.9.9-test $*"\n';
const PUBLISHED = 'x86_64-unknown-linux-gnu';

let root: string;
let releaseDir: string;
let server: ServerType;
let base: string;
let tamper = false;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'install-routes-'));
  releaseDir = join(root, 'release');
  await mkdir(releaseDir);
  await writeFile(join(releaseDir, `forge-runner-${PUBLISHED}`), BUILD);
  await writeFile(join(releaseDir, 'VERSION'), '9.9.9-test\n');
  await writeFile(join(releaseDir, 'COMMIT'), 'a'.repeat(40) + '\n');
  // published-build.ts reads RUNNER_RELEASE_DIR once, when it is first imported.
  process.env.RUNNER_RELEASE_DIR = releaseDir;
  const { installRoutes } = await import('./install-routes.js');

  const app = new Hono();
  // A byte added on the way, as a proxy or a corrupted transfer would: core still publishes the
  // sha256 of the build it holds, and the download no longer matches it.
  app.use('/api/install/bin/*', async (c, next) => {
    await next();
    if (!tamper) return;
    const body = new Uint8Array(await c.res.arrayBuffer());
    const changed = new Uint8Array(body.length + 1);
    changed.set(body);
    changed[body.length] = 0x58;
    c.res = new Response(changed, { status: c.res.status, headers: c.res.headers });
  });
  app.route('/api', installRoutes);

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

interface Install {
  code: number | null;
  stdout: string;
  stderr: string;
  home: string;
  bin: string;
}

/** Run the served install script as a box reporting `os`/`arch` would. */
async function install(
  name: string,
  os: string,
  arch: string,
  existing?: string,
): Promise<Install> {
  const box = join(root, name);
  const home = join(box, 'home');
  const shim = join(box, 'shim');
  await mkdir(home, { recursive: true });
  await mkdir(shim, { recursive: true });
  const uname = `#!/bin/sh\ncase "$1" in -s) echo "${os}";; -m) echo "${arch}";; *) exit 1;; esac\n`;
  await writeFile(join(shim, 'uname'), uname);
  await chmod(join(shim, 'uname'), 0o755);
  const bin = join(home, '.local', 'bin', 'forge-runner');
  if (existing !== undefined) {
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    await writeFile(bin, existing);
  }
  const script = await (await fetch(`${base}/api/install.sh`)).text();
  await writeFile(join(box, 'install.sh'), script);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(box, 'config'),
    PATH: `${shim}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  };
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [join(box, 'install.sh')], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, home, bin }));
  });
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

describe('REQ-25 BC-1: the served install command fetches the published build for the box platform', () => {
  it('the manifest names the published version and each built target with its sha256', async () => {
    const res = await fetch(`${base}/api/install/latest.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: '9.9.9-test',
      commit: 'a'.repeat(40),
      assets: {
        [PUBLISHED]: { url: `${base}/api/install/bin/${PUBLISHED}`, sha256: sha256(BUILD) },
      },
    });
  });

  it('a Linux x86_64 box gets the published x86_64-unknown-linux-gnu build, byte for byte', async () => {
    tamper = false;
    const run = await install('bc1', 'Linux', 'x86_64');
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`Downloading forge-runner (${PUBLISHED})`);
    expect(sha256(await readFile(run.bin))).toBe(sha256(BUILD));
  });
});

describe('REQ-25 BC-2: a build that does not match its published sha256 is refused by name', () => {
  it('a download changed on the way is refused INSTALL_SHA256_MISMATCH and the box keeps what it had', async () => {
    tamper = true;
    try {
      const run = await install('bc2', 'Linux', 'x86_64', 'the build this box already had');
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        `INSTALL_SHA256_MISMATCH: forge-runner for ${PUBLISHED} hashed ${sha256(`${BUILD}X`)}, core publishes ${sha256(BUILD)}; nothing was installed.`,
      );
      expect(await readFile(run.bin, 'utf8')).toBe('the build this box already had');
      expect(await exists(`${run.bin}.new`)).toBe(false);
    } finally {
      tamper = false;
    }
  });
});

describe('REQ-25 BC-3: a platform with no published build is refused by name, naming it', () => {
  for (const [os, arch, target] of [
    ['Linux', 'aarch64', 'aarch64-unknown-linux-gnu'],
    ['Darwin', 'x86_64', 'x86_64-apple-darwin'],
  ] as const) {
    it(`a ${os} ${arch} box is refused INSTALL_PLATFORM_UNPUBLISHED naming ${target}, and nothing is left behind`, async () => {
      const run = await install(`bc3-${target}`, os, arch);
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_PLATFORM_UNPUBLISHED: no forge-runner build is published for ${target} (${os} ${arch}); published: ${PUBLISHED}. Nothing was installed.\n`,
      );
      expect(await exists(join(run.home, '.local'))).toBe(false);
    });
  }

  it('the download route refuses the same target by name rather than with a bare 404', async () => {
    const res = await fetch(`${base}/api/install/bin/aarch64-unknown-linux-gnu`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      code: 'INSTALL_PLATFORM_UNPUBLISHED',
      error: `no forge-runner build is published for aarch64-unknown-linux-gnu; published: ${PUBLISHED}`,
    });
  });

  it('an architecture no target exists for is refused INSTALL_PLATFORM_UNSUPPORTED naming it', async () => {
    const run = await install('bc3-riscv', 'Linux', 'riscv64');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      'INSTALL_PLATFORM_UNSUPPORTED: forge-runner is built for x86_64 and aarch64, and this box is riscv64 (Linux)',
    );
    expect(await exists(join(run.home, '.local'))).toBe(false);
  });
});

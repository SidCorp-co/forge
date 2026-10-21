// @gate-input whole-tree — it runs the served install script under sh, which the guard cannot see
// into; the script reads only this file's scratch directory and the routes on loopback.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ServerType, serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { notFoundHandler } from '../middleware/error.js';

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
let downloadBroken = false;
let downloadDropped = false;
/** A loopback port nothing listens on: the build list there is unreachable. */
let closedPort: number;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'install-routes-'));
  releaseDir = join(root, 'release');
  await mkdir(releaseDir);
  await writeFile(join(releaseDir, `forge-runner-${PUBLISHED}`), BUILD);
  await writeFile(join(releaseDir, 'VERSION'), '9.9.9-test\n');
  await writeFile(join(releaseDir, 'COMMIT'), `${'a'.repeat(40)}\n`);
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
  // The download failing outright, as a proxy timing out or core restarting mid-install would.
  app.use('/api/install/bin/*', async (c, next) => {
    if (!downloadBroken) return next();
    return c.text('bad gateway', 502);
  });
  // The connection dropping mid-download, as a box losing its network would see: no HTTP answer.
  app.use('/api/install/bin/*', async (c, next) => {
    if (!downloadDropped) return next();
    (c.env as { incoming: { socket: { destroy(): void } } }).incoming.socket.destroy();
    return new Response(null);
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

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
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

interface InstallOptions {
  /** A build already installed on the box before the script runs. */
  existing?: string;
  /** Stand in for the core the script was served by, as a box that cannot reach it would see. */
  servedBy?: { base: string; prefix: string };
}

/** Run the served install script as a box reporting `os`/`arch` would. */
async function install(
  name: string,
  os: string,
  arch: string,
  { existing, servedBy }: InstallOptions = {},
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
  if (servedBy) {
    for (const line of [`BASE="${base}"`, 'PREFIX="/api"']) {
      if (!script.includes(line)) throw new Error(`the served script no longer carries ${line}`);
    }
    script = script
      .replace(`BASE="${base}"`, `BASE="${servedBy.base}"`)
      .replace('PREFIX="/api"', `PREFIX="${servedBy.prefix}"`);
  }
  await writeFile(join(box, 'install.sh'), script);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(box, 'config'),
    TMPDIR: scratch,
    PATH: `${shim}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  };
  const run = await new Promise<Install>((resolve, reject) => {
    const child = spawn('sh', [join(box, 'install.sh')], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, home, bin }));
  });
  // Whatever the script fetched it fetched into its own scratch, and it removes that on every exit.
  expect(await readdir(scratch)).toEqual([]);
  return run;
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
/** What every refusal of an HTTP answer ends with: the box reached core, so the next step is the admin's. */
const admin = () =>
  `This box reached ${base}, so its network is not the cause: show this message to your Forge admin.`;
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
      const run = await install('bc2', 'Linux', 'x86_64', {
        existing: 'the build this box already had',
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_SHA256_MISMATCH: forge-runner for ${PUBLISHED} hashed ${sha256(`${BUILD}X`)}, core publishes ${sha256(BUILD)}; nothing was installed. ` +
          `Run the install command again; if it fails the same way, something between this box and ${base} is changing the download, so tell your Forge admin.\n`,
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

  // A refusal names what is wrong. A box that cannot read the build list has not learned anything
  // about its platform, so it must never be told its platform has no build.
  describe('a build list the box cannot read is refused under its own name, never as an unpublished platform', () => {
    it('core unreachable: INSTALL_BUILD_LIST_UNREACHABLE names the URL and the curl failure', async () => {
      const unreachable = `http://127.0.0.1:${closedPort}`;
      const run = await install('list-unreachable', 'Linux', 'x86_64', {
        servedBy: { base: unreachable, prefix: '/api' },
      });
      expect(run.code).toBe(1);
      expect(run.stderr).not.toContain('INSTALL_PLATFORM_UNPUBLISHED');
      expect(run.stderr).toMatch(
        new RegExp(
          `^INSTALL_BUILD_LIST_UNREACHABLE: could not read the published build list at ${unreachable}/api/install/latest\\.json \\(curl exit 7: curl: \\(7\\) [^\\n]*\\); this box's platform \\(${PUBLISHED}\\) was not checked and nothing was installed\\. Check that this box can reach ${unreachable}, then run the install command again\\.\\n$`,
        ),
      );
      expect(await exists(join(run.home, '.local'))).toBe(false);
    });

    // Core reached and answering with an HTTP error is not a network failure: the person is told
    // what core said and sent to the Forge admin, never to check a network that just worked.
    it("core with no release published: INSTALL_BUILD_LIST_REFUSED carries HTTP 404 and core's reason", async () => {
      const version = join(releaseDir, 'VERSION');
      const held = join(root, 'VERSION.held');
      await rename(version, held);
      try {
        const res = await fetch(`${base}/api/install/latest.json`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'no release published' });
        const run = await install('list-no-release', 'Linux', 'x86_64');
        expect(run.code).toBe(1);
        expect(run.stderr).not.toContain('can reach');
        expect(run.stderr).toBe(
          `INSTALL_BUILD_LIST_REFUSED: ${base} answered the build list request at ${base}/api/install/latest.json with HTTP 404: no release published; this box's platform (${PUBLISHED}) was not checked and nothing was installed. ${admin()}\n`,
        );
        expect(await exists(join(run.home, '.local'))).toBe(false);
      } finally {
        await rename(held, version);
      }
    });

    it("a path core does not serve: INSTALL_BUILD_LIST_REFUSED carries HTTP 404 and the problem body's code and detail", async () => {
      const run = await install('list-404', 'Linux', 'x86_64', {
        servedBy: { base, prefix: '/api/no-such-prefix' },
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_BUILD_LIST_REFUSED: ${base} answered the build list request at ${base}/api/no-such-prefix/install/latest.json with HTTP 404: NOT_FOUND: Not Found: GET /api/no-such-prefix/install/latest.json; this box's platform (${PUBLISHED}) was not checked and nothing was installed. ${admin()}\n`,
      );
      expect(await exists(join(run.home, '.local'))).toBe(false);
    });

    it('an error page with no reason in it: INSTALL_BUILD_LIST_REFUSED says the status and that no reason was given', async () => {
      const run = await install('list-503', 'Linux', 'x86_64', {
        servedBy: { base, prefix: '/maintenance' },
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_BUILD_LIST_REFUSED: ${base} answered the build list request at ${base}/maintenance/install/latest.json with HTTP 503 and gave no reason; this box's platform (${PUBLISHED}) was not checked and nothing was installed. ${admin()}\n`,
      );
      expect(await exists(join(run.home, '.local'))).toBe(false);
    });

    it('a 200 that is not a build list: INSTALL_BUILD_LIST_UNREADABLE names the URL', async () => {
      const run = await install('list-not-json', 'Linux', 'x86_64', {
        servedBy: { base, prefix: '/portal' },
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_BUILD_LIST_UNREADABLE: ${base}/portal/install/latest.json answered, but not with a forge-runner build list; this box's platform (${PUBLISHED}) was not checked and nothing was installed. Check that ${base} is the Forge you meant to install from, then run the install command again.\n`,
      );
      expect(await exists(join(run.home, '.local'))).toBe(false);
    });
  });
});

describe('a download that fails is refused by name, and the box keeps what it had', () => {
  it('the build download answering 502: INSTALL_DOWNLOAD_REFUSED carries the status and the reason, and no partial file is left', async () => {
    downloadBroken = true;
    try {
      const run = await install('download-502', 'Linux', 'x86_64', {
        existing: 'the build this box already had',
      });
      expect(run.code).toBe(1);
      expect(run.stdout).toContain(`Downloading forge-runner (${PUBLISHED})`);
      expect(run.stderr).toBe(
        `INSTALL_DOWNLOAD_REFUSED: ${base} answered the download of ${base}/api/install/bin/${PUBLISHED} with HTTP 502: bad gateway; nothing was installed. ${admin()}\n`,
      );
      expect(await readFile(run.bin, 'utf8')).toBe('the build this box already had');
      expect(await exists(`${run.bin}.new`)).toBe(false);
    } finally {
      downloadBroken = false;
    }
  });

  it('a file:// mirror of the build list and the build installs, though it answers no HTTP status', async () => {
    const mirror = join(root, 'mirror');
    await mkdir(join(mirror, 'install', 'bin'), { recursive: true });
    await writeFile(
      join(mirror, 'install', 'latest.json'),
      await (await fetch(`${base}/api/install/latest.json`)).text(),
    );
    await writeFile(join(mirror, 'install', 'bin', PUBLISHED), BUILD);
    const run = await install('file-mirror', 'Linux', 'x86_64', {
      servedBy: { base: `file://${mirror}`, prefix: '' },
    });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(sha256(await readFile(run.bin))).toBe(sha256(BUILD));
  });

  it('the connection dropping mid-download: INSTALL_DOWNLOAD_FAILED keeps the network advice', async () => {
    downloadDropped = true;
    try {
      const run = await install('download-dropped', 'Linux', 'x86_64', {
        existing: 'the build this box already had',
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(
        new RegExp(
          `^INSTALL_DOWNLOAD_FAILED: could not download ${base}/api/install/bin/${PUBLISHED} \\(curl exit \\d+: curl: \\(\\d+\\) [^\\n]*\\); nothing was installed\\. Check that this box can reach ${base}, then run the install command again\\.\\n$`,
        ),
      );
      expect(await readFile(run.bin, 'utf8')).toBe('the build this box already had');
      expect(await exists(`${run.bin}.new`)).toBe(false);
    } finally {
      downloadDropped = false;
    }
  });
});

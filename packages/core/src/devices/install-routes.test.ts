// @gate-input whole-tree — it runs the served install script under sh, which the guard cannot see
// into; the script reads only this file's scratch directory and the routes on loopback.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BUILD,
  exists,
  type InstallWorld,
  installWorld,
  PUBLISHED,
  sha256,
} from '../../tests/helpers/install-world.js';

// REQ-25: the install command Forge serves fetches the published build for the box's platform,
// refuses a build whose sha256 is not the published one, and refuses by name a platform with no
// build. The served script runs for real against these routes on loopback (`install-world.ts`).

let w: InstallWorld;

beforeAll(async () => {
  w = await installWorld(async () => (await import('./install-routes.js')).installRoutes);
});

afterAll(async () => {
  await w.close();
});

/** What every refusal of an HTTP answer ends with: the box reached core, so the next step is the admin's. */
const admin = () =>
  `This box reached ${w.base}, so its network is not the cause: show this message to your Forge admin.`;

describe('REQ-25 BC-1: the served install command fetches the published build for the box platform', () => {
  it('the manifest names the published version and each built target with its sha256', async () => {
    const res = await fetch(`${w.base}/api/install/latest.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: '9.9.9-test',
      commit: 'a'.repeat(40),
      assets: {
        [PUBLISHED]: { url: `${w.base}/api/install/bin/${PUBLISHED}`, sha256: sha256(BUILD) },
      },
    });
  });

  it('a Linux x86_64 box gets the published x86_64-unknown-linux-gnu build, byte for byte', async () => {
    const run = await w.install('bc1', 'Linux', 'x86_64');
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      `Reading the forge-runner builds published at ${w.base}/api/install/latest.json...`,
    );
    expect(run.stdout).toContain(`Downloading forge-runner (${PUBLISHED})`);
    expect(sha256(await readFile(run.bin))).toBe(sha256(BUILD));
  });
});

describe('REQ-25 BC-2: a build that does not match its published sha256 is refused by name', () => {
  it('a download changed on the way is refused INSTALL_SHA256_MISMATCH and the box keeps what it had', async () => {
    w.download = 'tamper';
    try {
      const run = await w.install('bc2', 'Linux', 'x86_64', {
        existing: 'the build this box already had',
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_SHA256_MISMATCH: forge-runner for ${PUBLISHED} hashed ${sha256(`${BUILD}X`)}, core publishes ${sha256(BUILD)}; nothing was installed. ` +
          `Run the install command again; if it fails the same way, something between this box and ${w.base} is changing the download, so tell your Forge admin.\n`,
      );
      expect(await readFile(run.bin, 'utf8')).toBe('the build this box already had');
      expect(await exists(`${run.bin}.new`)).toBe(false);
    } finally {
      w.download = null;
    }
  });
});

describe('REQ-25 BC-3: a platform with no published build is refused by name, naming it', () => {
  for (const [os, arch, target] of [
    ['Linux', 'aarch64', 'aarch64-unknown-linux-gnu'],
    ['Darwin', 'x86_64', 'x86_64-apple-darwin'],
  ] as const) {
    it(`a ${os} ${arch} box is refused INSTALL_PLATFORM_UNPUBLISHED naming ${target}, and nothing is left behind`, async () => {
      const run = await w.install(`bc3-${target}`, os, arch);
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_PLATFORM_UNPUBLISHED: no forge-runner build is published for ${target} (${os} ${arch}); published: ${PUBLISHED}. Nothing was installed.\n`,
      );
      expect(await exists(join(run.home, '.local'))).toBe(false);
    });
  }

  it('the download route refuses the same target by name rather than with a bare 404', async () => {
    const res = await fetch(`${w.base}/api/install/bin/aarch64-unknown-linux-gnu`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      code: 'INSTALL_PLATFORM_UNPUBLISHED',
      error: `no forge-runner build is published for aarch64-unknown-linux-gnu; published: ${PUBLISHED}`,
    });
  });

  it('an architecture no target exists for is refused INSTALL_PLATFORM_UNSUPPORTED naming it', async () => {
    const run = await w.install('bc3-riscv', 'Linux', 'riscv64');
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
      const unreachable = `http://127.0.0.1:${w.closedPort}`;
      const run = await w.install('list-unreachable', 'Linux', 'x86_64', {
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
      const version = join(w.releaseDir, 'VERSION');
      const held = join(w.root, 'VERSION.held');
      await rename(version, held);
      try {
        const res = await fetch(`${w.base}/api/install/latest.json`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'no release published' });
        const run = await w.install('list-no-release', 'Linux', 'x86_64');
        expect(run.code).toBe(1);
        expect(run.stderr).not.toContain('can reach');
        expect(run.stderr).toBe(
          `INSTALL_BUILD_LIST_REFUSED: ${w.base} answered the build list request at ${w.base}/api/install/latest.json with HTTP 404: no release published; this box's platform (${PUBLISHED}) was not checked and nothing was installed. ${admin()}\n`,
        );
        expect(await exists(join(run.home, '.local'))).toBe(false);
      } finally {
        await rename(held, version);
      }
    });

    it("a path core does not serve: INSTALL_BUILD_LIST_REFUSED carries HTTP 404 and the problem body's code and detail", async () => {
      const run = await w.install('list-404', 'Linux', 'x86_64', {
        servedBy: { base: w.base, prefix: '/api/no-such-prefix' },
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_BUILD_LIST_REFUSED: ${w.base} answered the build list request at ${w.base}/api/no-such-prefix/install/latest.json with HTTP 404: NOT_FOUND: Not Found: GET /api/no-such-prefix/install/latest.json; this box's platform (${PUBLISHED}) was not checked and nothing was installed. ${admin()}\n`,
      );
      expect(await exists(join(run.home, '.local'))).toBe(false);
    });

    it('an error page with no reason in it: INSTALL_BUILD_LIST_REFUSED says the status and that no reason was given', async () => {
      const run = await w.install('list-503', 'Linux', 'x86_64', {
        servedBy: { base: w.base, prefix: '/maintenance' },
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_BUILD_LIST_REFUSED: ${w.base} answered the build list request at ${w.base}/maintenance/install/latest.json with HTTP 503 and gave no reason; this box's platform (${PUBLISHED}) was not checked and nothing was installed. ${admin()}\n`,
      );
      expect(await exists(join(run.home, '.local'))).toBe(false);
    });

    it('a reason holding an escaped quote and a backslash: INSTALL_BUILD_LIST_REFUSED carries it whole', async () => {
      const run = await w.install('list-quoted', 'Linux', 'x86_64', {
        servedBy: { base: w.base, prefix: '/quoted' },
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_BUILD_LIST_REFUSED: ${w.base} answered the build list request at ${w.base}/quoted/install/latest.json with HTTP 500: CORE_SAID: core said "stop" at C:\\forge\\new here; this box's platform (${PUBLISHED}) was not checked and nothing was installed. ${admin()}\n`,
      );
    });

    // A server that takes the connection and never answers is a connection failure, not an answer:
    // the person is told what the script is waiting on, and the wait ends at the script's own limit.
    it('a server that accepts and never answers: INSTALL_BUILD_LIST_UNREACHABLE inside the limit, naming it', async () => {
      const stalled = w.quietBase;
      const run = await w.install('list-stalled', 'Linux', 'x86_64', {
        servedBy: { base: stalled, prefix: '/api' },
        limits: { connect: 2, stall: 2 },
      });
      expect(run.killed).toBe(false);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe(
        `Reading the forge-runner builds published at ${stalled}/api/install/latest.json...\n`,
      );
      expect(run.stderr).toBe(
        `INSTALL_BUILD_LIST_UNREACHABLE: could not read the published build list at ${stalled}/api/install/latest.json (curl exit 28: the connection went quiet: nothing arrived for 2 s, the longest this install waits on one); this box's platform (${PUBLISHED}) was not checked and nothing was installed. Check that this box can reach ${stalled}, then run the install command again.\n`,
      );
      expect(run.ms).toBeGreaterThanOrEqual(1_500);
      expect(await exists(join(run.home, '.local'))).toBe(false);
    }, 20_000);

    it('a 200 that is not a build list: INSTALL_BUILD_LIST_UNREADABLE names the URL', async () => {
      const run = await w.install('list-not-json', 'Linux', 'x86_64', {
        servedBy: { base: w.base, prefix: '/portal' },
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_BUILD_LIST_UNREADABLE: ${w.base}/portal/install/latest.json answered, but not with a forge-runner build list; this box's platform (${PUBLISHED}) was not checked and nothing was installed. Check that ${w.base} is the Forge you meant to install from, then run the install command again.\n`,
      );
      expect(await exists(join(run.home, '.local'))).toBe(false);
    });
  });
});

describe('a download that fails is refused by name, and the box keeps what it had', () => {
  it('the build download answering 502: INSTALL_DOWNLOAD_REFUSED carries the status and the reason, and no partial file is left', async () => {
    w.download = 'bad-gateway';
    try {
      const run = await w.install('download-502', 'Linux', 'x86_64', {
        existing: 'the build this box already had',
      });
      expect(run.code).toBe(1);
      expect(run.stdout).toContain(`Downloading forge-runner (${PUBLISHED})`);
      expect(run.stderr).toBe(
        `INSTALL_DOWNLOAD_REFUSED: ${w.base} answered the download of ${w.base}/api/install/bin/${PUBLISHED} with HTTP 502: bad gateway; nothing was installed. ${admin()}\n`,
      );
      expect(await readFile(run.bin, 'utf8')).toBe('the build this box already had');
      expect(await exists(`${run.bin}.new`)).toBe(false);
    } finally {
      w.download = null;
    }
  });

  it('a file:// mirror of the build list and the build installs, though it answers no HTTP status', async () => {
    const mirror = join(w.root, 'mirror');
    await mkdir(join(mirror, 'install', 'bin'), { recursive: true });
    await writeFile(
      join(mirror, 'install', 'latest.json'),
      await (await fetch(`${w.base}/api/install/latest.json`)).text(),
    );
    await writeFile(join(mirror, 'install', 'bin', PUBLISHED), BUILD);
    const run = await w.install('file-mirror', 'Linux', 'x86_64', {
      servedBy: { base: `file://${mirror}`, prefix: '' },
    });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(sha256(await readFile(run.bin))).toBe(sha256(BUILD));
  });

  it('a download that goes quiet after its headers: INSTALL_DOWNLOAD_FAILED inside the limit, naming it', async () => {
    w.download = 'stalled';
    try {
      const run = await w.install('download-stalled', 'Linux', 'x86_64', {
        existing: 'the build this box already had',
        limits: { connect: 2, stall: 2 },
      });
      expect(run.killed).toBe(false);
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_DOWNLOAD_FAILED: could not download ${w.base}/api/install/bin/${PUBLISHED} (curl exit 28: the connection went quiet: nothing arrived for 2 s, the longest this install waits on one); nothing was installed. Check that this box can reach ${w.base}, then run the install command again.\n`,
      );
      expect(await readFile(run.bin, 'utf8')).toBe('the build this box already had');
      expect(await exists(`${run.bin}.new`)).toBe(false);
    } finally {
      w.download = null;
    }
  }, 20_000);

  it('a slow download that keeps moving installs, though it outlasts the quiet limit', async () => {
    w.download = 'slow';
    try {
      const run = await w.install('download-slow', 'Linux', 'x86_64', {
        limits: { connect: 2, stall: 2 },
      });
      expect(run.killed).toBe(false);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      expect(run.ms).toBeGreaterThan(2_500);
      expect(sha256(await readFile(run.bin))).toBe(sha256(BUILD));
    } finally {
      w.download = null;
    }
  }, 20_000);

  it('the connection dropping mid-download: INSTALL_DOWNLOAD_FAILED keeps the network advice', async () => {
    w.download = 'dropped';
    try {
      const run = await w.install('download-dropped', 'Linux', 'x86_64', {
        existing: 'the build this box already had',
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(
        new RegExp(
          `^INSTALL_DOWNLOAD_FAILED: could not download ${w.base}/api/install/bin/${PUBLISHED} \\(curl exit \\d+: curl: \\(\\d+\\) [^\\n]*\\); nothing was installed\\. Check that this box can reach ${w.base}, then run the install command again\\.\\n$`,
        ),
      );
      expect(await readFile(run.bin, 'utf8')).toBe('the build this box already had');
      expect(await exists(`${run.bin}.new`)).toBe(false);
    } finally {
      w.download = null;
    }
  });
});

describe('REQ-73 BC-5: the runners and pairing screens show one command that installs and pairs', () => {
  it('--setup goes straight on to forge-runner setup with the installed build, leaving no scratch', async () => {
    const run = await w.install('setup', 'Linux', 'x86_64', { args: ['--setup'] });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Running forge-runner setup');
    // the stand-in build echoes its arguments: setup ran, and it was the build just installed
    expect(run.stdout.trimEnd().endsWith('forge-runner 9.9.9-test setup')).toBe(true);
    expect(run.stdout).not.toContain('Next:  forge-runner setup');
  });

  it('without --setup the script stops at the install and names the next command', async () => {
    const run = await w.install('no-setup', 'Linux', 'x86_64');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Next:  forge-runner setup');
    expect(run.stdout).not.toContain('forge-runner 9.9.9-test setup');
  });
});

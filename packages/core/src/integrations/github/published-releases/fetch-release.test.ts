// @direct-test-of packages/core/src/integrations/github/published-releases/channel.ts
// @direct-test-of packages/core/src/integrations/github/published-releases/main-runner-head.ts
// @direct-test-of packages/core/src/devices/install-routes.ts
//
// ISS-1358: a core whose RUNNER_RELEASE_CHANNEL is `dev` serves the newest dev-channel prerelease
// (`runner-vX.Y.Z-dev.N`) and `latest.json` names its version and commit; unset, it serves main's
// line alone, as before. Both lines' releases are planted, the network is GitHub's API answered
// here, and what is read back is what a box reads: `/install/latest.json`.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runnerReleaseChannel } from '../../../lib/env.js';
import type { PublicRelease } from './public-releases.js';

const MAIN_SHA = 'a'.repeat(40);
const DEV_SHA = 'd'.repeat(40);
const OLD_DEV_SHA = 'e'.repeat(40);

function release(tag: string, prerelease: boolean, commit: string): PublicRelease {
  const at = (name: string) => ({
    name,
    browser_download_url: `https://github.test/${tag}/${name}`,
  });
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    assets: [at('forge-runner-x86_64-unknown-linux-gnu'), at('COMMIT'), at('VERSION')],
    commit,
  } as PublicRelease & { commit: string };
}

/** Newest first, as GitHub lists them: dev prereleases above main's newest release. */
const PLANTED = [
  release('runner-v0.18.0-dev.10', true, DEV_SHA),
  release('runner-v0.18.0-dev.9', true, OLD_DEV_SHA),
  release('runner-v0.17.143', false, MAIN_SHA),
  release('runner-v0.17.142', false, 'b'.repeat(40)),
];

let dir: string;
let branchesRead: string[];

function github(releases: PublicRelease[]) {
  branchesRead = [];
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/releases?')) {
      const page = Number(new URL(url).searchParams.get('page') ?? '1');
      return Response.json(page === 1 ? releases : []);
    }
    if (url.includes('/commits?')) {
      const branch = new URL(url).searchParams.get('sha') ?? '';
      branchesRead.push(branch);
      return Response.json([{ sha: branch === 'dev' ? DEV_SHA : MAIN_SHA }]);
    }
    const hit = releases.find((r) => url.startsWith(`https://github.test/${r.tag_name}/`));
    if (!hit) return new Response('missing', { status: 404 });
    const name = url.slice(url.lastIndexOf('/') + 1);
    const body =
      name === 'COMMIT'
        ? `${(hit as PublicRelease & { commit: string }).commit}\n`
        : `#!/bin/sh\necho "forge-runner ${hit.tag_name}"\n`;
    return new Response(body);
  });
}

async function latestJson(): Promise<Record<string, unknown>> {
  const { installRoutes } = await import('../../../devices/install-routes.js');
  const res = await installRoutes.request('http://localhost/install/latest.json');
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runner-release-'));
  vi.resetModules();
  vi.stubEnv('RUNNER_RELEASE_DIR', dir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe('ISS-1358 c2: the channel a core serves its runner build from', () => {
  it('on the dev channel, latest.json names the newest dev prerelease with its commit', async () => {
    vi.stubEnv('RUNNER_RELEASE_CHANNEL', 'dev');
    vi.stubGlobal('fetch', github(PLANTED));
    const { refetchRunnerRelease } = await import('./fetch-release.js');
    await refetchRunnerRelease();
    const body = await latestJson();
    expect(body.version).toBe('0.18.0-dev.10');
    expect(body.commit).toBe(DEV_SHA);
    expect(branchesRead).toEqual(['dev']);
  });

  it("unset, latest.json names main's newest release alone, as before", async () => {
    vi.stubGlobal('fetch', github(PLANTED));
    const { refetchRunnerRelease } = await import('./fetch-release.js');
    await refetchRunnerRelease();
    const body = await latestJson();
    expect(body.version).toBe('0.17.143');
    expect(body.commit).toBe(MAIN_SHA);
    expect(branchesRead).toEqual(['main']);
  });

  it('a core switched to dev replaces the main build it served, and never moves backwards within its line', async () => {
    await writeFile(join(dir, 'VERSION'), '0.17.143\n');
    vi.stubEnv('RUNNER_RELEASE_CHANNEL', 'dev');
    vi.stubGlobal('fetch', github(PLANTED));
    const first = await import('./fetch-release.js');
    await first.refetchRunnerRelease();
    expect((await readFile(join(dir, 'VERSION'), 'utf8')).trim()).toBe('0.18.0-dev.10');

    vi.resetModules();
    vi.stubGlobal('fetch', github(PLANTED.slice(1)));
    const second = await import('./fetch-release.js');
    await second.refetchRunnerRelease();
    expect((await readFile(join(dir, 'VERSION'), 'utf8')).trim()).toBe('0.18.0-dev.10');
  });

  it('a value other than main or dev is refused by name where it is read, and serves nothing', async () => {
    vi.stubEnv('RUNNER_RELEASE_CHANNEL', 'beta');
    const fetchMock = github(PLANTED);
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { refetchRunnerRelease } = await import('./fetch-release.js');
    await refetchRunnerRelease();
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    warn.mockRestore();
    expect(said).toContain('RUNNER_RELEASE_CHANNEL is "beta"');
    await expect(readFile(join(dir, 'VERSION'), 'utf8')).rejects.toThrow();
  });
});

describe('runnerReleaseChannel', () => {
  it('reads main where unset and main or dev as given', () => {
    expect(runnerReleaseChannel(undefined)).toBe('main');
    expect(runnerReleaseChannel('main')).toBe('main');
    expect(runnerReleaseChannel('dev')).toBe('dev');
  });

  it('refuses any other value by name and says what is valid', () => {
    expect(() => runnerReleaseChannel('Dev')).toThrow(
      'RUNNER_RELEASE_CHANNEL is "Dev"; it takes main or dev, or is left unset for main',
    );
  });
});

describe('cmpVersion orders the dev line against main', () => {
  it.each([
    ['0.18.0-dev.1', '0.18.0', 1],
    ['0.18.0-dev.10', '0.18.0-dev.9', 1],
    ['0.18.1', '0.18.0-dev.10', 1],
    ['0.17.143', '0.18.0-dev.1', -1],
    ['0.9.10-rc.1', '0.9.10', -1],
    ['0.18.0', '0.18.0', 0],
  ])('%s against %s is %i', async (a, b, sign) => {
    const { cmpVersion } = await import('./fetch-release.js');
    expect(Math.sign(cmpVersion(a, b))).toBe(sign);
  });
});

// @direct-test-of packages/core/src/devices/build-state.ts
// @direct-test-of packages/core/src/devices/published-build.ts
//
// ISS-1358: on RUNNER_RELEASE_CHANNEL=dev the published build is a dev-line prerelease and the head
// it is judged against is dev's runner head; a box's build and the release line are each read
// against those. RUNNER_RELEASE_DIR is set after this file imported the modules, so a read at
// import would answer nothing published.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmpVersion } from '../integrations/github/published-releases/fetch-release.js';
import { annotateDeviceBuilds } from './build-state.js';
import { provideDevicesPorts } from './ports.js';

const DEV_SHA = 'd'.repeat(40);
const NEWER_DEV_SHA = 'f'.repeat(40);
const MAIN_SHA = 'a'.repeat(40);

let dir: string;
let head: string | null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'build-state-'));
  vi.stubEnv('RUNNER_RELEASE_DIR', dir);
  await writeFile(join(dir, 'VERSION'), '0.18.0-dev.10\n');
  await writeFile(join(dir, 'COMMIT'), `${DEV_SHA}\n`);
  head = DEV_SHA;
  provideDevicesPorts({ cmpVersion, channelRunnerHead: () => head } as unknown as Parameters<
    typeof provideDevicesPorts
  >[0]);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function box(agentVersion: string | null, agentCommit: string | null) {
  const [row] = await annotateDeviceBuilds([{ agentVersion, agentCommit }]);
  if (!row) throw new Error('annotateDeviceBuilds answered no row for the one it was given');
  return row;
}

describe('a box judged against the dev channel release', () => {
  it('a box running the dev release, which carries dev’s runner head, is current on both', async () => {
    const row = await box('0.18.0-dev.10', DEV_SHA);
    expect(row.latestAgentVersion).toBe('0.18.0-dev.10');
    expect(row.mainRunnerHead).toBe(DEV_SHA);
    expect(row.agentBuildState).toBe('current');
    expect(row.runnerReleaseState).toBe('current');
    expect(row.agentOutdated).toBe(false);
  });

  it('an older dev prerelease and main’s release line are each behind the dev release', async () => {
    for (const version of ['0.18.0-dev.9', '0.17.143']) {
      const row = await box(version, MAIN_SHA);
      expect(row.agentBuildState).toBe('behind');
      expect(row.agentBuildDetail).toBe(`runner ${version} is behind the published 0.18.0-dev.10`);
    }
  });

  it('a dev head past the release reads the release behind, naming both commits', async () => {
    head = NEWER_DEV_SHA;
    const row = await box('0.18.0-dev.10', DEV_SHA);
    expect(row.agentBuildState).toBe('current');
    expect(row.runnerReleaseState).toBe('behind');
    expect(row.agentOutdated).toBe(true);
    expect(row.agentBuildDetail).toContain('carries dddddddddd');
    expect(row.agentBuildDetail).toContain('holds ffffffffff');
  });

  it('an unread head, or nothing published, is unknown rather than current', async () => {
    head = null;
    expect((await box('0.18.0-dev.10', DEV_SHA)).runnerReleaseState).toBe('unknown');
    vi.stubEnv('RUNNER_RELEASE_DIR', '');
    const row = await box('0.18.0-dev.10', DEV_SHA);
    expect(row.agentBuildState).toBe('unknown');
    expect(row.latestAgentVersion).toBeNull();
  });
});

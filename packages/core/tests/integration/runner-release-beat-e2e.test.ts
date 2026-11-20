/**
 * ISS-1358 c3: a box learns on its heartbeat which runner build core serves, so it checks for an
 * update when that build moves rather than only on its six-hour timer. The answer names the build
 * `install/latest.json` serves — version, and commit where the release recorded one — and moves on
 * the next beat once the served build does.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// set before the app is imported: `published-build.ts` reads the directory once, at import
const dir = vi.hoisted(() => {
  const d = `${process.env.TMPDIR ?? '/tmp'}/runner-release-beat-${process.pid}`;
  process.env.RUNNER_RELEASE_DIR = d;
  return d;
});

import { mintPat } from '../../src/credentials/pat.js';
import { api } from '../helpers/api.js';
import { createTestDevice, createTestUser, truncateAll } from '../helpers/factories.js';

let boxToken: string;

beforeEach(async () => {
  await truncateAll();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ownerId = (await createTestUser({ verified: true })).id;
  const deviceId = await createTestDevice(ownerId, { status: 'online' });
  boxToken = (await mintPat({ permissions: ['*'], userId: ownerId, name: 'box', deviceId }))
    .plaintext;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const beat = async () => {
  const res = await api(boxToken, 'POST', '/api/devices/heartbeat', { agentVersion: '0.18.0' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

describe('the heartbeat names the runner build core serves', () => {
  it('names the served version and commit, and the new build once the served one moves', async () => {
    writeFileSync(join(dir, 'VERSION'), '0.18.0-dev.9\n');
    writeFileSync(join(dir, 'COMMIT'), `${'e'.repeat(40)}\n`);
    expect((await beat()).runnerRelease).toEqual({
      version: '0.18.0-dev.9',
      commit: 'e'.repeat(40),
    });

    writeFileSync(join(dir, 'VERSION'), '0.18.0-dev.10\n');
    writeFileSync(join(dir, 'COMMIT'), `${'d'.repeat(40)}\n`);
    expect((await beat()).runnerRelease).toEqual({
      version: '0.18.0-dev.10',
      commit: 'd'.repeat(40),
    });
  });

  it('names no commit where the release recorded none, and nothing where nothing is served', async () => {
    writeFileSync(join(dir, 'VERSION'), '0.17.143\n');
    expect((await beat()).runnerRelease).toEqual({ version: '0.17.143' });

    rmSync(join(dir, 'VERSION'));
    expect(await beat()).not.toHaveProperty('runnerRelease');
  });
});

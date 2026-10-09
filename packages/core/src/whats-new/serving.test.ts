// Which release an instance serves: the shipped release whose commit the build is, the newest when a
// commit was cut twice, none for a build with no commit or a commit no release carries; an instance
// that names no environment or no product project is refused by name, never guessed.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  FORGE_ENVIRONMENT: undefined as string | undefined,
  FORGE_PRODUCT_PROJECT_ID: undefined as string | undefined,
}));
vi.mock('../lib/env.js', () => ({ env: settings }));
vi.mock('../lib/source-commit.js', () => ({ sourceCommit: null }));

import type { ShippedReleaseRun } from '../release-batch/index.js';
import { readServing, releaseOfBuild, requireServing } from './serving.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const run = (version: string, commit: string): ShippedReleaseRun => ({
  runId: `run-${version}`,
  version,
  commit,
  issueIds: [],
});
const shipped = [run('0.1.0', A), run('0.2.0', B), run('0.2.1', B)];
const PROJECT = '6d1f5a52-3c0e-4a39-9b7e-0b7c2d1e9a10';

beforeEach(() => {
  settings.FORGE_ENVIRONMENT = undefined;
  settings.FORGE_PRODUCT_PROJECT_ID = undefined;
});

describe('the release a build is', () => {
  it('is the shipped release whose commit the build was made from, a short sha included', () => {
    expect(releaseOfBuild(shipped, A)?.version).toBe('0.1.0');
    expect(releaseOfBuild(shipped, A.slice(0, 7))?.version).toBe('0.1.0');
  });

  it('is the newest of two releases cut at one commit', () => {
    expect(releaseOfBuild(shipped, B)?.version).toBe('0.2.1');
  });

  it('is none for a build with no commit, or a commit no release carries', () => {
    expect(releaseOfBuild(shipped, null)).toBeNull();
    expect(releaseOfBuild(shipped, 'c'.repeat(40))).toBeNull();
    expect(releaseOfBuild([], A)).toBeNull();
  });
});

describe('what an instance says it is', () => {
  it('serves the release of the project it names, in the environment it names', async () => {
    settings.FORGE_ENVIRONMENT = 'beta';
    settings.FORGE_PRODUCT_PROJECT_ID = PROJECT;
    const asked: string[] = [];
    const reading = await requireServing(B, async (id) => {
      asked.push(id);
      return shipped;
    });
    expect(reading).toEqual({
      environment: 'beta',
      release: { projectId: PROJECT, version: '0.2.1' },
    });
    expect(asked).toEqual([PROJECT]);
  });

  it.each([
    ['no environment', undefined, PROJECT, ['FORGE_ENVIRONMENT']],
    ['no product project', 'dev', undefined, ['FORGE_PRODUCT_PROJECT_ID']],
    ['neither', undefined, undefined, ['FORGE_ENVIRONMENT', 'FORGE_PRODUCT_PROJECT_ID']],
  ])('refuses an instance with %s, naming the setting', async (_, environment, project, names) => {
    settings.FORGE_ENVIRONMENT = environment;
    settings.FORGE_PRODUCT_PROJECT_ID = project;
    const read = vi.fn(async () => shipped);
    const err = await requireServing(A, read).catch((e: unknown) => e);
    expect(err).toMatchObject({ refusals: [{ code: 'WHATS_NEW_INSTANCE_UNSET' }] });
    for (const name of names) {
      expect(JSON.stringify((err as { refusals: unknown }).refusals)).toContain(name);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('reads an instance that names nothing as serving nothing, for the seen-mark rule to refuse on', async () => {
    expect(await readServing(A, async () => shipped)).toEqual({ environment: null, release: null });
  });
});

/**
 * ISS-1391 — what a project that ships by version tag owes a close. The rule's whole job is to say
 * "no tag carries this" truthfully, so each case plants the one reading that must change its answer:
 * the tag held, no tag held, none existing, no landing commit, and the read itself failing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryAccess, TagContainment } from '../projects/repository-reader.js';

const selects: unknown[][] = [];
const dbSelect = vi.fn(() => ({
  from: () => ({ where: () => ({ limit: async () => selects.shift() ?? [] }) }),
}));
vi.mock('../db/client.js', () => ({ db: { select: () => dbSelect() } }));

const tagsContaining = vi.fn(
  async (_c: string, _p: string): Promise<TagContainment> => ({
    why: 'unscripted',
  }),
);
let access: RepositoryAccess | Error = {
  kind: 'reader',
  reader: {
    tagsContaining,
  } as unknown as import('../projects/repository-reader.js').RepositoryReader,
};
const withRepository = vi.fn(
  async (_projectId: string, fn: (a: RepositoryAccess) => Promise<unknown>) => {
    if (access instanceof Error) throw access;
    return fn(access);
  },
);
vi.mock('../projects/repository-access.js', () => ({
  withRepository: (...a: Parameters<typeof withRepository>) => withRepository(...a),
}));

const { refuseUnreleasedClose, releaseTagOf } = await import('./release-tag-close.js');

const PROJECT = '22222222-2222-4222-8222-222222222222';
const ISSUE = '11111111-1111-4111-8111-111111111111';
const LANDING = '6de20f6092dcf9bdb1c8efe03db4b70c82b423dd';

function project(releaseChain: unknown[]) {
  selects.push([{ releaseChain }]);
}
function issue(observed: string | null, claimed: string | null = null) {
  selects.push([{ observed, claimed }]);
}
const TAGGED = [{ branch: 'dev', tag: 'v*.*.*' }];
const close = (toStatus: 'closed' | 'dropped' | 'awaiting_release' = 'closed') =>
  refuseUnreleasedClose({ id: ISSUE, projectId: PROJECT }, toStatus);

beforeEach(() => {
  selects.length = 0;
  vi.clearAllMocks();
  tagsContaining.mockReset();
  access = {
    kind: 'reader',
    reader: {
      tagsContaining,
    } as unknown as import('../projects/repository-reader.js').RepositoryReader,
  };
});

describe('a project that names no release tag', () => {
  it.each([
    ['ships nothing', []],
    ['publishes one branch', [{ branch: 'main' }]],
    ['promotes across two', [{ branch: 'dev' }, { branch: 'main', from: 'merge-branch' }]],
  ])('is owed nothing, and its repository is never read, when its chain %s', async (_, chain) => {
    project(chain);
    expect(await close()).toBeNull();
    expect(withRepository).not.toHaveBeenCalled();
  });

  it('is asked nothing at all for a status that is not a close', async () => {
    expect(await close('awaiting_release')).toBeNull();
    expect(await close('dropped')).toBeNull();
    expect(dbSelect).not.toHaveBeenCalled();
  });
});

describe('releaseTagOf', () => {
  it('reads the pattern off the last entry, and null for no project at all', async () => {
    project([{ branch: 'dev' }, { branch: 'main', from: 'merge-branch', tag: 'v*' }]);
    expect(await releaseTagOf(PROJECT)).toBe('v*');
    expect(await releaseTagOf(PROJECT)).toBeNull();
  });
});

describe('a project that ships by version tag', () => {
  it('lets the close through where a matching tag contains the landing commit, asking the reader for that pattern', async () => {
    project(TAGGED);
    issue(LANDING);
    tagsContaining.mockResolvedValue({
      commit: LANDING,
      matching: ['v1.19.0'],
      containing: ['v1.19.0'],
    });

    expect(await close()).toBeNull();
    expect(tagsContaining).toHaveBeenCalledWith(LANDING, 'v*.*.*');
  });

  it('refuses where no matching tag contains it, naming the landing, the newest tag and where the issue rests', async () => {
    project(TAGGED);
    issue(LANDING);
    tagsContaining.mockResolvedValue({
      commit: LANDING,
      matching: ['v1.18.0', 'v1.9.0'],
      containing: [],
    });

    const refusal = await close();

    expect(refusal?.code).toBe('CLOSE_REQUIRES_RELEASE_TAG');
    expect(refusal?.detail).toContain(LANDING);
    expect(refusal?.detail).toContain('`v1.18.0`');
    expect(refusal?.detail).toContain('`awaiting_release`');
    expect(refusal?.detail).toContain('`v*.*.*`');
    expect(refusal?.details).toMatchObject({
      requires: 'releaseTag',
      pattern: 'v*.*.*',
      landing: LANDING,
      newestTag: 'v1.18.0',
      matchingTags: 2,
      rests: 'awaiting_release',
    });
  });

  it('says so where no tag matching the pattern exists yet', async () => {
    project(TAGGED);
    issue(LANDING);
    tagsContaining.mockResolvedValue({ commit: LANDING, matching: [], containing: [] });

    const refusal = await close();

    expect(refusal?.detail).toContain('no tag matching it exists yet');
    expect(refusal?.details).toMatchObject({ newestTag: null, matchingTags: 0 });
  });

  it('looks for the commit a caller claimed where none was observed', async () => {
    project(TAGGED);
    issue(null, 'abc1234');
    tagsContaining.mockResolvedValue({
      commit: LANDING,
      matching: ['v1.0.0'],
      containing: ['v1.0.0'],
    });

    expect(await close()).toBeNull();
    expect(tagsContaining).toHaveBeenCalledWith('abc1234', 'v*.*.*');
  });

  it('refuses an issue with no landing commit, saying so, without reading the repository', async () => {
    project(TAGGED);
    issue(null, null);

    const refusal = await close();

    expect(refusal?.code).toBe('CLOSE_REQUIRES_RELEASE_TAG');
    expect(refusal?.detail).toContain('carries no landing commit');
    expect(refusal?.details).toMatchObject({ landing: null, rests: 'awaiting_release' });
    expect(withRepository).not.toHaveBeenCalled();
  });

  it('treats a blank commit as none', async () => {
    project(TAGGED);
    issue('   ', '');
    expect((await close())?.details).toMatchObject({ landing: null });
  });
});

describe('a tag list that could not be read is never read as one holding no tag', () => {
  it('refuses RELEASE_TAG_UNREAD with the reader`s reason', async () => {
    project(TAGGED);
    issue(LANDING);
    tagsContaining.mockResolvedValue({ why: 'o/r could not read which tags hold it: HTTP 502' });

    const refusal = await close();

    expect(refusal?.code).toBe('RELEASE_TAG_UNREAD');
    expect(refusal?.detail).toContain('HTTP 502');
    expect(refusal?.details).toMatchObject({ read: 'unread', landing: LANDING });
  });

  it('refuses RELEASE_TAG_UNREAD where the project has no repository access, naming the act that clears it', async () => {
    project(TAGGED);
    issue(LANDING);
    access = {
      kind: 'refused',
      unbound: true,
      route: 'binding',
      cause: 'no repository is bound',
      clears: 'bind one',
    };

    const refusal = await close();

    expect(refusal?.code).toBe('RELEASE_TAG_UNREAD');
    expect(refusal?.detail).toContain('no repository is bound — bind one');
    expect(tagsContaining).not.toHaveBeenCalled();
  });

  it('refuses RELEASE_TAG_UNREAD where resolving the repository itself throws', async () => {
    project(TAGGED);
    issue(LANDING);
    access = new Error('connection reset');

    const refusal = await close();

    expect(refusal?.code).toBe('RELEASE_TAG_UNREAD');
    expect(refusal?.detail).toContain('connection reset');
  });
});

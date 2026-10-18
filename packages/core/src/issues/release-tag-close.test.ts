/**
 * ISS-1391 — what a project that ships by version tag owes a close. The rule's whole job is to say
 * "no tag carries this" truthfully, so each case plants the one reading that must change its answer:
 * the tag held, no tag held, none existing, no landing commit, and the read itself failing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryAccess, TagContainment } from '../projects/repository-reader.js';

const selects: unknown[][] = [];
const limit = () => {
  const rows = selects.shift() ?? [];
  return Object.assign(Promise.resolve(rows), { for: async () => rows });
};
const selectBuilder = () => ({ from: () => ({ where: () => ({ limit }) }) });
const dbSelect = vi.fn(selectBuilder);
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

const { holdReleaseTagClose, releaseTagOf } = await import('./release-tag-close.js');

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
type Options = { beforeStatusWrite?: ((tx: never) => Promise<void>) | undefined };
const hold = (
  toStatus: 'closed' | 'dropped' | 'awaiting_release' = 'closed',
  options: Options = {},
) => holdReleaseTagClose({ id: ISSUE, projectId: PROJECT }, toStatus, options as never);
/** What a refused close rejects with, so a case names the code and not "it threw". */
const refused = async (toStatus?: 'closed') => {
  const err = await hold(toStatus).then(
    () => null,
    (e: unknown) => e as { code: string; detail: string; details: Record<string, unknown> },
  );
  expect(err, 'the close was not refused').not.toBeNull();
  return err as { code: string; detail: string; details: Record<string, unknown> };
};

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
    const options = {};

    expect(await hold('closed', options)).toBe(options);
    expect(withRepository).not.toHaveBeenCalled();
  });

  it('is asked nothing at all for a status that is not a close', async () => {
    const options = {};
    expect(await hold('awaiting_release', options)).toBe(options);
    expect(await hold('dropped', options)).toBe(options);
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

    await hold();

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

    const refusal = await refused();

    expect(refusal.code).toBe('CLOSE_REQUIRES_RELEASE_TAG');
    expect(refusal.detail).toContain(LANDING);
    expect(refusal.detail).toContain('`v1.18.0`');
    expect(refusal.detail).toContain('Awaiting release');
    expect(refusal.detail).toContain('`v*.*.*`');
    expect(refusal.details).toMatchObject({
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

    const refusal = await refused();

    expect(refusal.detail).toContain('no tag matching it exists yet');
    expect(refusal.details).toMatchObject({ newestTag: null, matchingTags: 0 });
  });

  it('looks for the commit a caller claimed where none was observed', async () => {
    project(TAGGED);
    issue(null, 'abc1234');
    tagsContaining.mockResolvedValue({
      commit: LANDING,
      matching: ['v1.0.0'],
      containing: ['v1.0.0'],
    });

    await hold();

    expect(tagsContaining).toHaveBeenCalledWith('abc1234', 'v*.*.*');
  });

  it('refuses an issue with no landing commit, saying so, without reading the repository', async () => {
    project(TAGGED);
    issue(null, null);

    const refusal = await refused();

    expect(refusal.code).toBe('CLOSE_REQUIRES_RELEASE_TAG');
    expect(refusal.detail).toContain('carries no landing commit');
    expect(refusal.details).toMatchObject({ landing: null, rests: 'awaiting_release' });
    expect(withRepository).not.toHaveBeenCalled();
  });

  it('treats a blank commit as none', async () => {
    project(TAGGED);
    issue('   ', '');
    expect((await refused()).details).toMatchObject({ landing: null });
  });
});

describe('a tag list that could not be read is never read as one holding no tag', () => {
  it('refuses RELEASE_TAG_UNREAD with the reader`s reason', async () => {
    project(TAGGED);
    issue(LANDING);
    tagsContaining.mockResolvedValue({ why: 'o/r could not read which tags hold it: HTTP 502' });

    const refusal = await refused();

    expect(refusal.code).toBe('RELEASE_TAG_UNREAD');
    expect(refusal.detail).toContain('HTTP 502');
    expect(refusal.details).toMatchObject({ read: 'unread', landing: LANDING });
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

    const refusal = await refused();

    expect(refusal.code).toBe('RELEASE_TAG_UNREAD');
    expect(refusal.detail).toMatch(/close again\.\nNo repository is bound\. Bind one\.$/);
    expect(tagsContaining).not.toHaveBeenCalled();
  });

  it('refuses RELEASE_TAG_UNREAD where resolving the repository itself throws', async () => {
    project(TAGGED);
    issue(LANDING);
    access = new Error('connection reset');

    const refusal = await refused();

    expect(refusal.code).toBe('RELEASE_TAG_UNREAD');
    expect(refusal.detail).toContain('connection reset');
  });
});

describe('the landing commit a tag was shown to hold is held inside the transaction', () => {
  async function allowed(before?: () => Promise<void>) {
    project(TAGGED);
    issue(LANDING);
    tagsContaining.mockResolvedValue({
      commit: LANDING,
      matching: ['v1.0.0'],
      containing: ['v1.0.0'],
    });
    const out = (await hold('closed', before ? { beforeStatusWrite: before } : {})) as Options;
    return out.beforeStatusWrite as (tx: { select: typeof selectBuilder }) => Promise<void>;
  }
  const tx = { select: selectBuilder };

  it('lets the write on where the issue still holds that commit, and runs the caller`s own hook after it', async () => {
    const own = vi.fn(async () => undefined);
    const guard = await allowed(own);
    issue(LANDING);

    await guard(tx);

    expect(own).toHaveBeenCalledTimes(1);
  });

  it('stops the write, as a stale transition, where the mark was cleared and made again on another commit', async () => {
    const own = vi.fn(async () => undefined);
    const guard = await allowed(own);
    issue('b'.repeat(40));

    const err = await guard(tx).then(
      () => null,
      (e: unknown) => e as { code: string; detail: string; details: Record<string, unknown> },
    );

    expect(err).toMatchObject({ code: 'STALE_TRANSITION', details: { judged: LANDING } });
    expect(err?.detail).toContain(LANDING);
    expect(own).not.toHaveBeenCalled();
  });

  it('stops the write where the mark was cleared and not made again', async () => {
    const guard = await allowed();
    issue(null, null);

    await expect(guard(tx)).rejects.toMatchObject({ code: 'STALE_TRANSITION' });
  });
});

/**
 * The sequence, steps 1 to 6, and what each refusal leaves behind.
 *
 * Read the file as one claim: at every point this sequence can stop, the row it
 * leaves says which step stopped it and what is true on the repository — and
 * the three tag states after a failed `cut_tag` are the whole of ISS-1075's
 * third outcome, so they are asserted one by one rather than as a group.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

class FakeClientError extends Error {}
const githubRepoClient = vi.fn(async () => ({
  bindingId: 'binding-1',
  appId: '7',
  owner: 'SidCorp-co',
  repo: 'forge',
  fullName: 'SidCorp-co/forge',
}));
vi.mock('./client.js', () => ({
  githubRepoClient: () => githubRepoClient(),
  GitHubClientError: FakeClientError,
}));

/** A Cargo.toml and a Cargo.lock that both say 0.13.3, which is the happy path. */
const agreeingFiles = async (_c: unknown, path: string): Promise<string> =>
  path.endsWith('Cargo.toml')
    ? '[workspace.package]\nversion = "0.13.3"\n'
    : '[[package]]\nname = "forge-runner"\nversion = "0.13.3"\n\n[[package]]\nname = "forge-runner-core"\nversion = "0.13.3"\n';

class FakeRepoError extends Error {
  constructor(
    readonly refusal: {
      cause: string;
      op: string;
      status: number | null;
      message: string;
      detail?: string | null;
    },
    readonly beforeWrite: boolean,
  ) {
    super(refusal.message);
  }
}
const repo = {
  readDefaultBranch: vi.fn(async () => 'main'),
  readCommitSha: vi.fn(async () => 'abc1234'),
  readTagRef: vi.fn<(...a: unknown[]) => Promise<{ sha: string } | null>>(async () => null),
  readFileAtRef: vi.fn<(c: unknown, path: string) => Promise<string>>(agreeingFiles),
  createTagRef: vi.fn(async () => ({ sha: 'abc1234' })),
};
vi.mock('./runner-release-repo.js', () => ({
  readDefaultBranch: (...a: unknown[]) => repo.readDefaultBranch(...(a as [])),
  readCommitSha: (...a: unknown[]) => repo.readCommitSha(...(a as [])),
  readTagRef: (...a: unknown[]) => repo.readTagRef(...a),
  readFileAtRef: (...a: unknown[]) => repo.readFileAtRef(...(a as [unknown, string])),
  createTagRef: (...a: unknown[]) => repo.createTagRef(...(a as [])),
  RunnerReleaseRepoError: FakeRepoError,
  // cm:guard the double reads GitHub's own body, exactly as `runner-release-repo.ts` does. Matching `message` here instead would make every 422 in this file read as a tag that already exists, which is the defect the real function was carrying.
  saysRefExists: (r: { status: number | null; detail?: string | null }) =>
    r.status === 422 && /already exists/i.test(r.detail ?? ''),
  tagRefName: (tag: string) => `refs/tags/${tag}`,
}));

type Row = Record<string, unknown> & {
  id: string;
  tag: string;
  tagState: string;
  attempt: number;
};
const rows = new Map<string, Row>();
vi.mock('./runner-release-store.js', () => ({
  openRunnerRelease: async (args: Record<string, unknown>) => {
    const key = `${args.projectId}:${args.tag}`;
    const held = rows.get(key);
    // cm:guard the double of the real statement's WHERE, both halves: a row still in flight is HELD whatever its tag state, and a settled one re-arms only from `unread` or `absent`.
    if (held && !(held.settledAt && ['unread', 'absent'].includes(held.tagState))) {
      return { opened: null, held };
    }
    if (held) {
      Object.assign(held, {
        status: 'preflight',
        step: 'resolve_repository',
        tagState: 'unread',
        failure: null,
        readings: [],
        settledAt: null,
        attempt: (held.attempt as number) + 1,
      });
      return { opened: held, held: null };
    }
    const row: Row = {
      id: key,
      projectId: args.projectId,
      bindingId: args.bindingId,
      repository: args.repository,
      version: args.version,
      tag: args.tag as string,
      commitSha: null,
      status: 'preflight',
      step: 'resolve_repository',
      tagState: 'unread',
      publication: 'unread',
      publicationDetail: null,
      failure: null,
      readings: [],
      settledAt: null,
      attempt: 1,
      startedAt: new Date('2026-09-18T00:00:00.000Z'),
    };
    rows.set(key, row);
    return { opened: row, held: null };
  },
  // cm:guard each double carries the same `attempt` fence the statement does, so a case that
  // re-arms a row proves the sequence is passing the attempt through rather than the double being
  // forgiving about it.
  appendReading: async (id: string, attempt: number, line: string) => {
    const row = rows.get(id);
    if (row && row.attempt === attempt) (row.readings as string[]).push(line);
  },
  advance: async (id: string, attempt: number, patch: Record<string, unknown>) => {
    const row = rows.get(id);
    if (!row || row.settledAt || row.attempt !== attempt) return false;
    Object.assign(row, patch);
    return true;
  },
  settleFailed: async (id: string, attempt: number, patch: Record<string, unknown>) => {
    const row = rows.get(id);
    if (!row || row.settledAt || row.attempt !== attempt) return false;
    const guard = patch.ifUnchanged as { step: string; tagState: string } | undefined;
    if (guard && (row.step !== guard.step || row.tagState !== guard.tagState)) return false;
    const { ifUnchanged: _guard, ...sets } = patch;
    Object.assign(row, sets, { status: 'failed', settledAt: new Date() });
    return true;
  },
  findById: async (id: string) => rows.get(id) ?? null,
}));

const { startRunnerRelease } = await import('./runner-release.js');

const start = (over: Record<string, unknown> = {}) =>
  startRunnerRelease({ projectId: 'p1', version: '0.13.3', requestedById: null, ...over } as never);

const row = () => rows.get('p1:runner-v0.13.3');

const publishError = (
  over: Partial<{
    cause: string;
    op: string;
    status: number | null;
    message: string;
    detail: string | null;
  }>,
) =>
  new FakeRepoError(
    { cause: 'unknown', op: 'create', status: null, message: 'refused', detail: null, ...over },
    over.op === 'lookup',
  );

// cm:guard the implementations are restored by hand, because `vi.clearAllMocks` clears CALLS and not `mockImplementation` — a Cargo.lock a preflight case rewrote would otherwise leak into every later case and stop the sequence two steps before the one under test, with the failure reading as a bug in `cut_tag`.
beforeEach(() => {
  rows.clear();
  vi.clearAllMocks();
  repo.readFileAtRef.mockImplementation(agreeingFiles);
  repo.readDefaultBranch.mockResolvedValue('main');
  repo.readCommitSha.mockResolvedValue('abc1234');
  repo.readTagRef.mockResolvedValue(null);
  repo.createTagRef.mockResolvedValue({ sha: 'abc1234' });
});

describe('the whole sequence when nothing is wrong', () => {
  it('cuts the tag and hands the release to the build', async () => {
    const outcome = await start();
    expect(outcome.started).toBe(true);
    // cm:guard the MESSAGE travels with the create, because the artefact is an annotated tag and `forge-runner 0.13.3` is the wording every hand-cut `runner-v*` tag on this repository carries.
    expect(repo.createTagRef).toHaveBeenCalledWith(
      expect.anything(),
      'runner-v0.13.3',
      'abc1234',
      'forge-runner 0.13.3',
    );
    expect(row()?.status).toBe('building');
    expect(row()?.step).toBe('await_build');
    expect(row()?.tagState).toBe('present');
    expect(row()?.commitSha).toBe('abc1234');
    expect(row()?.settledAt).toBeNull();
  });

  it('records one reading per step it took', async () => {
    await start();
    expect(row()?.readings).toEqual([
      'resolve_repository: SidCorp-co/forge via binding binding-1',
      'resolve_commit: abc1234 (main)',
      'check_tag_absent: SidCorp-co/forge holds no runner-v0.13.3',
      'check_crate_version: Cargo.toml declares 0.13.3',
      'check_lockfile_version: Cargo.lock records 0.13.3',
      'cut_tag: refs/tags/runner-v0.13.3 created as an annotated tag at abc1234 by the App on SidCorp-co/forge',
    ]);
  });

  it('cuts at the commit a caller named instead of the default branch head', async () => {
    repo.readCommitSha.mockResolvedValue('feedbee');
    await start({ commit: 'feedbee' });
    expect(repo.readDefaultBranch).not.toHaveBeenCalled();
    expect(repo.createTagRef).toHaveBeenCalledWith(
      expect.anything(),
      'runner-v0.13.3',
      'feedbee',
      'forge-runner 0.13.3',
    );
  });
});

describe('the refusals that write no row at all', () => {
  it('refuses a project with no repository, naming what is missing', async () => {
    githubRepoClient.mockRejectedValueOnce(
      new FakeClientError('this project has no active GitHub binding'),
    );
    const outcome = await start();
    expect(outcome).toMatchObject({ started: false, kind: 'no_repository', release: null });
    expect(rows.size).toBe(0);
  });

  it('refuses a version that names no tag', async () => {
    const outcome = await start({ version: 'runner-v0.13.3' });
    expect(outcome).toMatchObject({ started: false, kind: 'bad_version' });
    expect(rows.size).toBe(0);
    expect(repo.createTagRef).not.toHaveBeenCalled();
  });
});

describe('the preflights, each naming the step and that nothing was written', () => {
  it('stops when the tag is already there, naming the commit it points at', async () => {
    repo.readTagRef.mockResolvedValue({ sha: 'olderco' });
    const outcome = await start();
    expect(outcome.started).toBe(false);
    expect(row()?.step).toBe('check_tag_absent');
    expect(row()?.tagState).toBe('present');
    expect(String(row()?.failure)).toContain(
      'already exists on SidCorp-co/forge, pointing at olderco',
    );
    expect(repo.createTagRef).not.toHaveBeenCalled();
  });

  it('stops when the manifest disagrees with the tag', async () => {
    repo.readFileAtRef.mockImplementation(async (_c: unknown, path: string) =>
      path.endsWith('Cargo.toml')
        ? '[workspace.package]\nversion = "0.13.2"\n'
        : '[[package]]\nname = "forge-runner"\nversion = "0.13.3"\n',
    );
    const outcome = await start();
    expect(outcome.started).toBe(false);
    expect(row()?.step).toBe('check_crate_version');
    expect(String(row()?.failure)).toContain('perpetual update loop');
    expect(String(row()?.failure)).toContain('Nothing was written to the repository');
    expect(repo.createTagRef).not.toHaveBeenCalled();
  });

  it('stops when the lockfile disagrees with the manifest', async () => {
    repo.readFileAtRef.mockImplementation(async (_c: unknown, path: string) =>
      path.endsWith('Cargo.toml')
        ? '[workspace.package]\nversion = "0.13.3"\n'
        : '[[package]]\nname = "forge-runner"\nversion = "0.13.2"\n\n[[package]]\nname = "forge-runner-core"\nversion = "0.13.2"\n',
    );
    const outcome = await start();
    expect(row()?.step).toBe('check_lockfile_version');
    expect(String(row()?.failure)).toContain('--locked');
    expect(outcome.started).toBe(false);
    expect(repo.createTagRef).not.toHaveBeenCalled();
  });

  // cm:guard every act before `cut_tag` is a read, so a refusal there is EVIDENCE that nothing was written — which is what makes the same version runnable again afterwards. What it is NOT evidence of is the tag's absence: the lookup that would have said so is the one that failed.
  it('leaves the tag UNREAD when the lookup itself is refused, not absent', async () => {
    repo.readTagRef.mockRejectedValue(
      publishError({ op: 'lookup', status: 403, message: 'forbidden' }),
    );
    await start();
    expect(row()?.tagState).toBe('unread');
    expect(row()?.step).toBe('check_tag_absent');
    expect(String(row()?.failure)).toContain('Nothing was written to the repository');
    expect(String(row()?.failure)).toContain('did not read whether the tag');
    expect(String(row()?.failure)).not.toContain('does not exist');
  });

  it('leaves the tag UNREAD when the commit cannot be resolved at all', async () => {
    repo.readCommitSha.mockRejectedValue(
      publishError({ op: 'lookup', status: 404, message: 'no such commit' }),
    );
    await start();
    expect(row()?.tagState).toBe('unread');
    expect(row()?.step).toBe('resolve_commit');
    expect(repo.readTagRef).not.toHaveBeenCalled();
  });

  // cm:guard the other side of the same line: here the lookup ANSWERED and said the tag is not there, so `absent` is a reading and the sentence may say the tag does not exist.
  it('leaves the tag absent when the lookup answered before a later step stopped it', async () => {
    repo.readFileAtRef.mockImplementation(async () => '[workspace.package]\nversion = "0.13.2"\n');
    await start();
    expect(row()?.tagState).toBe('absent');
    expect(row()?.step).toBe('check_crate_version');
    expect(String(row()?.failure)).toContain('the tag `runner-v0.13.3` does not exist');
  });
});

describe('the three things that can be true after a cut that did not answer', () => {
  it('leaves the tag absent when GitHub answered the create with a refusal', async () => {
    repo.createTagRef.mockRejectedValue(
      publishError({ op: 'create', status: 403, message: 'GitHub refused Forge' }),
    );
    const outcome = await start();
    expect(outcome.started).toBe(false);
    expect(row()?.tagState).toBe('absent');
    expect(row()?.step).toBe('cut_tag');
    expect(String(row()?.failure)).toContain('the tag `runner-v0.13.3` does not exist');
  });

  // cm:guard this is the row ISS-1075 point 3 exists for. A create that timed out may or may not have been taken, and calling it `absent` is what lets the next attempt cut over a tag that is already there.
  it('leaves the tag UNKNOWN when the create never answered', async () => {
    repo.createTagRef.mockRejectedValue(
      publishError({
        op: 'create',
        status: null,
        cause: 'timed-out-mid-write',
        message: 'Forge timed out',
      }),
    );
    await start();
    expect(row()?.tagState).toBe('unknown');
    expect(String(row()?.failure)).toContain('may or may not exist');
    expect(String(row()?.failure)).toContain('deletes none and re-cuts none');
  });

  it('leaves the tag present when GitHub says the ref is already there', async () => {
    repo.createTagRef.mockRejectedValue(
      publishError({
        op: 'create',
        status: 422,
        message: 'GitHub refused the request as unprocessable: usually a ref that already exists',
        detail: '{"message":"Reference already exists"}',
      }),
    );
    await start();
    expect(row()?.tagState).toBe('present');
    expect(String(row()?.failure)).toContain('`runner-v0.13.3` exists at abc1234');
  });

  // cm:guard a 5xx is NOT a refusal that proves nothing was written: GitHub can commit the ref and then fall over answering, and `absent` here is what lets the next attempt cut over a tag that is already on the repository.
  it('leaves the tag UNKNOWN when the create answered 502', async () => {
    repo.createTagRef.mockRejectedValue(
      publishError({ op: 'create', status: 502, message: 'bad gateway' }),
    );
    await start();
    expect(row()?.tagState).toBe('unknown');
    expect(String(row()?.failure)).toContain('may or may not exist');
  });

  // cm:guard the create SUCCEEDED here — GitHub answered 201 — and only reading the body failed, which `client.ts` reports as a `GitHubPublishError` carrying status 201. Any rule that reads "a status arrived" as "nothing was written" records the tag absent over a tag that exists.
  it('leaves the tag UNKNOWN when the create answered 201 and its body could not be read', async () => {
    repo.createTagRef.mockRejectedValue(
      publishError({
        op: 'create',
        status: 201,
        message: 'POST /git/refs answered HTTP 201 and its body could not be read',
      }),
    );
    await start();
    expect(row()?.tagState).toBe('unknown');
    expect(String(row()?.failure)).toContain('may or may not exist');
  });

  it('records the intent before the request, so a death mid-write is visible', async () => {
    let seen: string | undefined;
    repo.createTagRef.mockImplementation(async () => {
      seen = row()?.tagState as string;
      return { sha: 'abc1234' };
    });
    await start();
    expect(seen).toBe('unknown');
  });
});

describe('a row that went terminal under the sequence', () => {
  // cm:guard the irreversible act may not outrun the record of the intent. `advance` is conditional on the row being non-terminal, so its `false` is the deadline pass or a delivery having settled this release a moment ago — and a tag created after that point is a ref on GitHub no row can ever record, because every write left is conditional too.
  it('sends no create request when the intent write was refused', async () => {
    repo.readFileAtRef.mockImplementation(async (_c: unknown, path: string) => {
      if (path.endsWith('Cargo.lock')) {
        const settling = rows.get('p1:runner-v0.13.3');
        if (settling) {
          settling.settledAt = new Date();
          settling.status = 'failed';
          settling.failure = 'the deadline named this release while the sequence was running';
        }
      }
      return agreeingFiles(_c, path);
    });
    const outcome = await start();
    expect(repo.createTagRef).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ started: false, kind: 'stopped' });
    expect('message' in outcome && outcome.message).toContain('the deadline named this release');
    expect(row()?.tagState).toBe('absent');
  });

  // cm:guard the caller is handed the STORED row and never a synthesis over the opening snapshot: the POST's answer and an immediate GET of the same release are two reads of one fact, and a synthesized one reports a step and a readings list the row does not carry.
  it('answers with the persisted row rather than the opening snapshot', async () => {
    const outcome = await start();
    expect(outcome.started).toBe(true);
    expect(outcome.started && outcome.release).toBe(row());
    expect(outcome.started && outcome.release.step).toBe('await_build');
    expect(outcome.started && outcome.release.readings).toHaveLength(6);
  });

  it('answers a refusal with the persisted row too', async () => {
    repo.createTagRef.mockRejectedValue(
      publishError({ op: 'create', status: 403, message: 'GitHub refused Forge' }),
    );
    const outcome = await start();
    expect(outcome.started).toBe(false);
    expect(!outcome.started && outcome.release).toBe(row());
    expect(!outcome.started && outcome.release?.status).toBe('failed');
    expect(!outcome.started && outcome.release?.settledAt).not.toBeNull();
  });
});

describe('what a second attempt at one version may do', () => {
  it('runs again after a refusal that wrote nothing', async () => {
    repo.readFileAtRef.mockImplementationOnce(
      async () => '[workspace.package]\nversion = "0.13.2"\n',
    );
    expect((await start()).started).toBe(false);
    const again = await start();
    expect(again.started).toBe(true);
    expect(row()?.tagState).toBe('present');
  });

  it('is refused once the tag exists, naming when the first attempt stopped', async () => {
    await start();
    const again = await start();
    expect(again).toMatchObject({ started: false, kind: 'already_attempted' });
    expect('message' in again && again.message).toContain('Cut the next version instead');
  });

  it('is refused while the tag is of unknown existence', async () => {
    repo.createTagRef.mockRejectedValue(
      publishError({
        op: 'create',
        status: null,
        cause: 'timed-out-mid-write',
        message: 'Forge timed out',
      }),
    );
    await start();
    const again = await start();
    expect(again).toMatchObject({ started: false, kind: 'already_attempted' });
    expect('message' in again && again.message).toContain('may or may not exist');
  });
});

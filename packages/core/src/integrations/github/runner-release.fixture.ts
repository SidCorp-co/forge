/**
 * The store and repository doubles the sequence's suites run against.
 *
 * Lifted out of `runner-release.test.ts` when that file passed the 500-line
 * budget, and kept as ONE copy on purpose: every double here is a model of a
 * statement in `runner-release-store.ts`, and two copies of a model drift
 * apart silently — a suite whose double forgot the `attempt` fence, or the
 * re-arm's `settled_at IS NOT NULL`, goes green over code that lost it.
 *
 * `.fixture.ts` because that suffix is what `tsconfig.build.json` excludes, so
 * this file's `vitest` import never reaches a build.
 */

/** A row as the doubles hold it: the columns these suites read, and nothing else. */
export type FixtureRow = Record<string, unknown> & {
  id: string;
  tag: string;
  tagState: string;
  attempt: number;
};

/** A Cargo.toml and a Cargo.lock that both say 0.13.3, which is the happy path. */
export const agreeingFiles = async (_c: unknown, path: string): Promise<string> =>
  path.endsWith('Cargo.toml')
    ? '[workspace.package]\nversion = "0.13.3"\n'
    : '[[package]]\nname = "forge-runner"\nversion = "0.13.3"\n\n[[package]]\nname = "forge-runner-core"\nversion = "0.13.3"\n';

/** The double of `RunnerReleaseRepoError`, carrying the two fields callers read. */
export class FakeRepoError extends Error {
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

export const publishError = (
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

// cm:guard the double reads GitHub's own body, exactly as `runner-release-repo.ts` does. Matching `message` here instead would make every 422 in these suites read as a tag that already exists, which is the defect the real function was carrying.
export const saysRefExists = (r: { status: number | null; detail?: string | null }) =>
  r.status === 422 && /already exists/i.test(r.detail ?? '');

/** Every row these suites wrote, keyed `<projectId>:<tag>` as the store keys them. */
export const rows = new Map<string, FixtureRow>();

// cm:guard the double of the real statement's WHERE, both halves: a row still in flight is HELD whatever its tag state, and a settled one re-arms only from `unread` or `absent` — and the re-arm bumps the attempt, so a caller holding the old one writes nothing afterwards.
export async function openRunnerRelease(args: Record<string, unknown>) {
  const key = `${args.projectId}:${args.tag}`;
  const held = rows.get(key);
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
  const row: FixtureRow = {
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
}

// cm:guard every double below carries the same `attempt` fence the statement does, so a case that re-arms a row proves the sequence is passing the attempt through rather than the double being forgiving about it.
export async function appendReading(id: string, attempt: number, line: string) {
  const row = rows.get(id);
  if (row && row.attempt === attempt) (row.readings as string[]).push(line);
}

export async function advance(id: string, attempt: number, patch: Record<string, unknown>) {
  const row = rows.get(id);
  if (!row || row.settledAt || row.attempt !== attempt) return false;
  Object.assign(row, patch);
  return true;
}

export async function settleFailed(id: string, attempt: number, patch: Record<string, unknown>) {
  const row = rows.get(id);
  if (!row || row.settledAt || row.attempt !== attempt) return false;
  const guard = patch.ifUnchanged as { step: string; tagState: string } | undefined;
  if (guard && (row.step !== guard.step || row.tagState !== guard.tagState)) return false;
  const { ifUnchanged: _guard, ...sets } = patch;
  Object.assign(row, sets, { status: 'failed', settledAt: new Date() });
  return true;
}

export async function findById(id: string) {
  return rows.get(id) ?? null;
}

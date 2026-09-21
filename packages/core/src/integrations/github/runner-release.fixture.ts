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

export const saysRefExists = (r: { status: number | null; detail?: string | null }) =>
  r.status === 422 && /already exists/i.test(r.detail ?? '');

/** Every row these suites wrote, keyed `<projectId>:<tag>` as the store keys them. */
export const rows = new Map<string, FixtureRow>();

/**
 * What another writer does in the gap between two of this module's statements.
 *
 * The sequence's writes are not one statement, and the races that matter all
 * live between two of them — a settle and its read-back, an insert and its
 * read-back. A suite that cannot stand in those gaps cannot test them at all,
 * so the gaps are named here rather than left to timing.
 */
export const between: {
  settleAndReadBack: ((row: FixtureRow) => void) | null;
} = { settleAndReadBack: null };

export async function openRunnerRelease(args: Record<string, unknown>) {
  const key = `${args.projectId}:${args.tag}`;
  const held = rows.get(key);
  if (held && !(held.settledAt && ['unread', 'absent'].includes(held.tagState))) {
    return { opened: null, held: { ...held } };
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
    return { opened: { ...held }, held: null };
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
  return { opened: { ...row }, held: null };
}

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
  between.settleAndReadBack?.(row);
  return true;
}

export async function findById(id: string) {
  const row = rows.get(id);
  return row ? { ...row } : null;
}

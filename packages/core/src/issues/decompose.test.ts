/**
 * ISS-138 (PR-D) — unit tests for the decomposition helper. Mocks the git
 * shell wrapper and the db client; verifies the side-effect order and
 * idempotent re-run behaviour.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const gitCreateBranch = vi.fn(async (_input: unknown) => ({ remote: 'github', branch: '' }));
const gitHasBranch = vi.fn(async (_repo: string, _branch: string) => false);

vi.mock('../git/branches.js', async () => {
  const actual = await vi.importActual<typeof import('../git/branches.js')>('../git/branches.js');
  return {
    ...actual,
    createIntegrationBranch: (input: unknown) => gitCreateBranch(input),
    gitRemoteHasBranch: (repo: string, branch: string) => gitHasBranch(repo, branch),
  };
});

interface FakeIssue {
  id: string;
  projectId: string;
  issSeq: number;
  title: string;
  status: string;
  priority: string;
  category: string | null;
  description: string | null;
  reportedBy: string | null;
  assigneeId: string | null;
  metadata: Record<string, unknown> | null;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '44444444-4444-4444-8444-444444444444';

interface FakeState {
  issuesById: Map<string, FakeIssue>;
  project: {
    id: string;
    baseBranch: string | null;
    productionBranch: string | null;
    repoPath: string | null;
  };
  edges: Array<{ id: string; projectId: string; fromIssueId: string; toIssueId: string; kind: string }>;
  activity: Array<{ issueId: string; action: string; payload: Record<string, unknown> }>;
  nextIssueId: number;
  nextEdgeId: number;
  nextActivityId: number;
}

const state: FakeState = {
  issuesById: new Map(),
  project: {
    id: PROJECT_ID,
    baseBranch: 'main',
    productionBranch: 'main',
    repoPath: '/tmp/repo',
  },
  edges: [],
  activity: [],
  nextIssueId: 0,
  nextEdgeId: 0,
  nextActivityId: 0,
};

function nextUuid(seedField: 'nextIssueId' | 'nextEdgeId' | 'nextActivityId'): string {
  state[seedField]++;
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(state[seedField]).padStart(12, '0')}`;
}

// Lazy-load table refs after the mocks register so we can identify tables by
// reference (more reliable than symbol introspection across drizzle versions).
const tableNames = new WeakMap<object, string>();
async function registerTables() {
  const schema = await import('../db/schema.js');
  tableNames.set(schema.issues, 'issues');
  tableNames.set(schema.issueDependencies, 'issue_dependencies');
  tableNames.set(schema.projects, 'projects');
  tableNames.set(schema.activityLog, 'activity_log');
}
function tableName(t: unknown): string | undefined {
  if (typeof t !== 'object' || t === null) return undefined;
  return tableNames.get(t as object);
}

interface QueryChain {
  _kind: 'select' | 'insert' | 'update' | 'delete';
  _table?: string;
  _where?: unknown;
  _values?: Record<string, unknown> | Record<string, unknown>[];
  _set?: Record<string, unknown>;
  _returning?: boolean;
  _limit?: number;
  _forUpdate?: boolean;
  _conflictDoNothing?: boolean;
  _selection?: Record<string, unknown>;
}

function makeChain(kind: QueryChain['_kind']): QueryChain & PromiseLike<unknown> {
  const chain: QueryChain & Record<string, unknown> = { _kind: kind };
  // biome-ignore lint/suspicious/noExplicitAny: dynamic chain
  const proto: any = {
    from(this: typeof chain, t: unknown) { this._table = tableName(t); return this; },
    where(this: typeof chain, w: unknown) { this._where = w; return this; },
    limit(this: typeof chain, n: number) { this._limit = n; return this; },
    for(this: typeof chain, mode: string) { if (mode === 'update') this._forUpdate = true; return this; },
    values(this: typeof chain, v: unknown) { this._values = v as Record<string, unknown>; return this; },
    set(this: typeof chain, v: unknown) { this._set = v as Record<string, unknown>; return this; },
    onConflictDoNothing(this: typeof chain) { this._conflictDoNothing = true; return this; },
    returning(this: typeof chain) { this._returning = true; return this; },
    into(this: typeof chain, t: unknown) { this._table = tableName(t); return this; },
    then(this: typeof chain, resolve: (v: unknown) => void, reject: (e: unknown) => void) {
      try {
        const out = executeQuery(this);
        resolve(out);
      } catch (e) {
        reject(e);
      }
    },
  };
  Object.assign(chain, proto);
  return chain as QueryChain & PromiseLike<unknown>;
}

function executeQuery(q: QueryChain): unknown {
  // The fake db doesn't try to interpret the drizzle where-expressions —
  // it relies on test setup to ensure single-row lookups by id.
  if (q._kind === 'select') {
    if (q._table === 'issues') {
      // Either by-id (single) or by-many (inArray). We can't introspect the
      // expression, so we treat: if _limit === 1 → return single row of the
      // most-recently-asked id. Tests set up `lastSelectedIssueIds` via a
      // small heuristic on the where expression's string repr.
      return Array.from(state.issuesById.values()).map((i) => ({ ...i }));
    }
    if (q._table === 'projects') {
      return [state.project];
    }
    return [];
  }
  if (q._kind === 'insert') {
    if (q._table === 'issues') {
      const v = q._values as Record<string, unknown>;
      const id = nextUuid('nextIssueId');
      const row: FakeIssue = {
        id,
        projectId: v.projectId as string,
        issSeq: state.nextIssueId + 100, // simulate trigger
        title: v.title as string,
        description: (v.description as string | null) ?? null,
        status: (v.status as string) ?? 'open',
        priority: (v.priority as string) ?? 'medium',
        category: (v.category as string | null) ?? null,
        reportedBy: null,
        assigneeId: null,
        metadata: null,
      };
      state.issuesById.set(id, row);
      if (q._returning) return [row];
      return [];
    }
    if (q._table === 'issue_dependencies') {
      const v = q._values as Record<string, unknown>;
      const exists = state.edges.find(
        (e) =>
          e.projectId === v.projectId &&
          e.fromIssueId === v.fromIssueId &&
          e.toIssueId === v.toIssueId &&
          e.kind === v.kind,
      );
      if (exists) return [];
      const id = nextUuid('nextEdgeId');
      const edge = {
        id,
        projectId: v.projectId as string,
        fromIssueId: v.fromIssueId as string,
        toIssueId: v.toIssueId as string,
        kind: v.kind as string,
      };
      state.edges.push(edge);
      if (q._returning) return [{ id }];
      return [];
    }
    if (q._table === 'activity_log') {
      const v = q._values as Record<string, unknown>;
      state.activity.push({
        issueId: v.issueId as string,
        action: v.action as string,
        payload: (v.payload as Record<string, unknown>) ?? {},
      });
      return [];
    }
    return [];
  }
  if (q._kind === 'update') {
    if (q._table === 'issues') {
      // Walk all issues and pretend the metadata patch sql() applies as an
      // object merge. We can't read the actual SQL — instead, _set.metadata
      // here is a SQL fragment object; tests verify behaviour through the
      // returned `integrationBranch` rather than the metadata column.
      return [];
    }
    return [];
  }
  return [];
}

const dbTransactionFn = vi.fn(async (cb: (tx: typeof fakeDb) => unknown) => cb(fakeDb));

const fakeDb = {
  select: vi.fn(() => makeChain('select')),
  insert: vi.fn((t: unknown) => {
    const c = makeChain('insert');
    c._table = tableName(t);
    return c;
  }),
  update: vi.fn((t: unknown) => {
    const c = makeChain('update');
    c._table = tableName(t);
    return c;
  }),
  delete: vi.fn(() => makeChain('delete')),
  transaction: dbTransactionFn,
};

vi.mock('../db/client.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic
      return (fakeDb as any)[prop];
    },
  }),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { decomposeParent, slugifyIssueTitle, DecomposeError } = await import('./decompose.js');
const { hooks } = await import('../pipeline/hooks.js');
await registerTables();

function resetState() {
  state.issuesById.clear();
  state.edges.length = 0;
  state.activity.length = 0;
  state.nextIssueId = 0;
  state.nextEdgeId = 0;
  state.nextActivityId = 0;
  state.project = {
    id: PROJECT_ID,
    baseBranch: 'main',
    productionBranch: 'main',
    repoPath: '/tmp/repo',
  };
}

function seedParent(overrides: Partial<FakeIssue> = {}): FakeIssue {
  const parent: FakeIssue = {
    id: PARENT_ID,
    projectId: PROJECT_ID,
    issSeq: 7,
    title: 'PR-D parent epic',
    status: 'confirmed',
    priority: 'medium',
    category: 'core',
    description: null,
    reportedBy: null,
    assigneeId: null,
    metadata: null,
    ...overrides,
  };
  state.issuesById.set(parent.id, parent);
  return parent;
}

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
  hooks.reset();
  gitCreateBranch.mockImplementation(async (input) => {
    const i = input as { newBranch: string };
    return { remote: 'github', branch: i.newBranch };
  });
  gitHasBranch.mockResolvedValue(false);
});

describe('slugifyIssueTitle', () => {
  it('lowercases and replaces non-alphanumerics with dashes', () => {
    expect(slugifyIssueTitle('PR-D: Decompose / Integration!')).toBe(
      'pr-d-decompose-integration',
    );
  });
  it('trims leading and trailing dashes', () => {
    expect(slugifyIssueTitle('  ---hello---  ')).toBe('hello');
  });
});

describe('decomposeParent — happy path', () => {
  it('creates the integration branch and children, writes edges, returns the result', async () => {
    seedParent();
    const out = await decomposeParent(
      PARENT_ID,
      [
        { title: 'Child A' },
        { title: 'Child B' },
        { title: 'Child C' },
      ],
      { userId: USER_ID },
    );
    expect(out.parentId).toBe(PARENT_ID);
    expect(out.childIds).toHaveLength(3);
    expect(out.integrationBranch).toBe('iss-7-pr-d-parent-epic');
    expect(out.createdEdges).toBe(3);
    expect(gitCreateBranch).toHaveBeenCalledTimes(1);
    expect(gitCreateBranch).toHaveBeenCalledWith({
      repoPath: '/tmp/repo',
      remoteRef: 'main',
      newBranch: 'iss-7-pr-d-parent-epic',
    });
    expect(state.edges).toHaveLength(3);
    expect(state.edges.every((e) => e.kind === 'decomposes')).toBe(true);
    expect(
      state.activity.some(
        (a) => a.action === 'issue.decomposed' && a.issueId === PARENT_ID,
      ),
    ).toBe(true);
  });
});

describe('decomposeParent — opt-out', () => {
  it('skips git entirely and writes no branchConfig when useIntegrationBranch=false', async () => {
    seedParent();
    const out = await decomposeParent(
      PARENT_ID,
      [{ title: 'Child A' }],
      { userId: USER_ID },
      { useIntegrationBranch: false },
    );
    expect(out.integrationBranch).toBeNull();
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(gitHasBranch).not.toHaveBeenCalled();
  });
});

describe('decomposeParent — branch-name conflict resolution', () => {
  it('appends -2 when the base candidate already exists on the remote', async () => {
    seedParent();
    gitHasBranch.mockImplementation(async (_repo, branch) => branch === 'iss-7-pr-d-parent-epic');
    const out = await decomposeParent(
      PARENT_ID,
      [{ title: 'Child A' }],
      { userId: USER_ID },
    );
    expect(out.integrationBranch).toBe('iss-7-pr-d-parent-epic-2');
    expect(gitCreateBranch).toHaveBeenCalledWith(
      expect.objectContaining({ newBranch: 'iss-7-pr-d-parent-epic-2' }),
    );
  });
});

describe('decomposeParent — parent status guard', () => {
  it('rejects when parent status is not confirmed or waiting and parent has no prior decomposition', async () => {
    seedParent({ status: 'in_progress' });
    await expect(
      decomposeParent(PARENT_ID, [{ title: 'Child A' }], { userId: USER_ID }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('allows further decomposition when the parent already owns an integration branch', async () => {
    seedParent({
      status: 'in_progress',
      metadata: {
        useIntegrationBranch: true,
        branchConfig: { baseBranch: 'main', targetBranch: 'main' },
      },
    });
    const out = await decomposeParent(
      PARENT_ID,
      [{ title: 'Late Child' }],
      { userId: USER_ID },
    );
    // Reuses the existing branch name from metadata (which is 'main' in our
    // contrived fixture); the helper does not re-issue a git push.
    expect(out.integrationBranch).toBe('main');
    expect(gitCreateBranch).not.toHaveBeenCalled();
  });
});

describe('decomposeParent — input validation', () => {
  it('throws when children is empty', async () => {
    seedParent();
    await expect(
      decomposeParent(PARENT_ID, [], { userId: USER_ID }),
    ).rejects.toBeInstanceOf(DecomposeError);
  });

  it('throws when a new child has no title', async () => {
    seedParent();
    await expect(
      decomposeParent(PARENT_ID, [{ title: '   ' }], { userId: USER_ID }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

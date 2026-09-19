import { beforeEach, describe, expect, it, vi } from 'vitest';

const executed: string[] = [];
const updateSets: Record<string, unknown>[] = [];
const insertedComments: Record<string, unknown>[] = [];
const selectRows: unknown[][] = [];

/** `select().from().where()[.for('update')].limit()` — a thenable answering every chain step. */
function selectChain() {
  const rows = selectRows.shift() ?? [];
  const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  p.limit = () => Promise.resolve(rows);
  p.for = () => p;
  return p;
}

const handle = {
  execute: (q: unknown) => {
    executed.push(JSON.stringify(q));
    return Promise.resolve(executeAnswer.shift() ?? [{ id: 'new-issue-1' }]);
  },
  select: () => ({ from: () => ({ where: () => selectChain() }) }),
  update: () => ({
    set: (patch: Record<string, unknown>) => {
      updateSets.push(patch);
      return { where: () => Promise.resolve(undefined) };
    },
  }),
  insert: () => ({
    values: (v: Record<string, unknown>) => {
      insertedComments.push(v);
      return Promise.resolve(undefined);
    },
  }),
};

vi.mock('../../db/client.js', () => ({
  db: {
    ...handle,
    transaction: (fn: (tx: typeof handle) => Promise<unknown>) => {
      transactions.push(1);
      return fn(handle);
    },
  },
}));

const transactions: number[] = [];

const executeAnswer: unknown[][] = [];

const listBindingsMock = vi.fn<() => Promise<unknown[]>>();
const buildCtxMock = vi.fn();
vi.mock('../store.js', () => ({
  listActiveBindingsForProjectProvider: () => listBindingsMock(),
  buildContextFromBinding: (...a: unknown[]) => buildCtxMock(...(a as [])),
}));

const listSentryIssuesMock = vi.fn();
vi.mock('./issues.js', () => ({
  listSentryIssues: (...a: unknown[]) => listSentryIssuesMock(...(a as [])),
}));

const readThresholdsMock = vi.fn();
vi.mock('../../admin/thresholds.js', () => ({ readThresholds: () => readThresholdsMock() }));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runSentryPull } = await import('./intake.js');

const PROJECT = '11111111-1111-4111-8111-111111111111';
const TARGET = { label: 'forge-core', organizationSlug: 'canawan', projectSlug: 'forge-core' };

function issue(over: Record<string, unknown> = {}) {
  return {
    id: '4411',
    shortId: 'FORGE-CORE-9K',
    status: 'unresolved',
    substatus: 'ongoing',
    level: 'error',
    count: 17,
    userCount: 3,
    firstSeen: '2026-09-01T00:00:00Z',
    lastSeen: '2026-09-17T09:00:00Z',
    permalink: 'https://logs.canawan.com/organizations/canawan/issues/4411/',
    projectSlug: 'forge-core',
    title: 'TypeError: cannot read x',
    culprit: 'app/chat/send',
    metadataValue: 'cannot read x of undefined',
    ...over,
  };
}

/** A binding whose config declares one target. */
function bindingFound(targets: unknown[] = [TARGET]) {
  listBindingsMock.mockResolvedValue([{ binding: { id: 'bind-1' }, connection: { id: 'conn-1' } }]);
  buildCtxMock.mockReturnValue({
    connectionId: 'conn-1',
    bindingId: 'bind-1',
    projectId: PROJECT,
    config: { host: 'logs.canawan.com', targets },
    secrets: { authToken: 'sntryu_current' },
  });
}

function answers(issues: unknown[], refused: unknown[] = []) {
  listSentryIssuesMock.mockResolvedValue({
    result: { deliveryId: 'del-1', durationMs: 5 },
    target: TARGET,
    issues,
    refused,
  });
}

/** The project-creator lookup every pull makes. */
function creatorFound() {
  selectRows.push([{ createdBy: 'user-1' }]);
}

beforeEach(() => {
  executed.length = 0;
  updateSets.length = 0;
  insertedComments.length = 0;
  selectRows.length = 0;
  executeAnswer.length = 0;
  transactions.length = 0;
  vi.clearAllMocks();
  readThresholdsMock.mockResolvedValue({ sentryMinEventCount: 10, sentryMinUserCount: 2 });
});

describe('F6 — the baseline sighting goes in WITH the filed row', () => {
  it('writes metadata.sentry in the insert, so the first re-sighting has something to compare to', async () => {
    bindingFound();
    creatorFound();
    selectRows.push([]);
    answers([issue({ count: 17 })]);

    await runSentryPull({ projectId: PROJECT });

    const stmt = executed[0] ?? '';
    expect(stmt).toContain(
      'INSERT INTO issues (project_id, title, description, created_by_id, source, external_id, detector_key, status, created_via, metadata)',
    );
    // the parameter is a JSON string inside the stringified statement, so the quotes are escaped
    expect(stmt).toContain('\\"count\\":17');
    expect(stmt).toContain('\\"shortId\\":\\"FORGE-CORE-9K\\"');
  });

  it('posts NO comment on a first re-sighting at an unchanged count', async () => {
    // the row as the insert above would have left it
    bindingFound();
    creatorFound();
    selectRows.push([
      { id: 'iss-1', metadata: { sentry: { shortId: 'FORGE-CORE-9K', count: 17 } } },
    ]);
    selectRows.push([
      { id: 'iss-1', metadata: { sentry: { shortId: 'FORGE-CORE-9K', count: 17 } } },
    ]); // the locked re-read inside the transaction
    answers([issue({ count: 17 })]);

    await runSentryPull({ projectId: PROJECT });

    expect(insertedComments).toEqual([]);
  });

  it('posts NO comment where no sighting was ever recorded, rather than treating null as growth', async () => {
    bindingFound();
    creatorFound();
    selectRows.push([{ id: 'iss-1', metadata: null }]);
    selectRows.push([{ id: 'iss-1', metadata: null }]); // the locked re-read inside the transaction
    answers([issue({ count: 17 })]);

    await runSentryPull({ projectId: PROJECT });

    expect(insertedComments).toEqual([]);
    expect(updateSets).toHaveLength(1);
  });
});

describe('F2 — the two writes an observation makes, and the order between them', () => {
  it('OBSERVES the row that won a race instead of throwing the sighting away', async () => {
    bindingFound();
    creatorFound();
    selectRows.push([]); // findFiled: nothing yet
    selectRows.push([{ id: 'iss-1', metadata: { sentry: { count: 17 } } }]);
    selectRows.push([{ id: 'iss-1', metadata: { sentry: { count: 17 } } }]); // the locked re-read inside the transaction // the winner, reloaded
    executeAnswer.push([]); // the insert loses the race
    answers([issue({ count: 41 })]);

    const outcome = await runSentryPull({ projectId: PROJECT });

    expect(insertedComments).toHaveLength(1);
    expect(String(insertedComments[0]?.body)).toContain('- Events: 41 (was 17)');
    expect(outcome.output).not.toMatch(/raced/);
  });
});

describe('F4 — a decision is reported when it is made, not when the loop finishes', () => {
  it('keeps the refusals already made when a later issue throws', async () => {
    bindingFound();
    creatorFound();
    selectRows.push([]); // the refused one is looked up first
    // the second issue's lookup throws
    selectRows.push(undefined as unknown as unknown[]);
    answers([issue({ shortId: 'A-1', count: 3 }), issue({ shortId: 'B-2', count: 99 })]);
    // make the second lookup reject
    const originalShift = selectRows.shift.bind(selectRows);
    selectRows.shift = (() => {
      const v = originalShift();
      if (v === undefined) throw new Error('lookup exploded');
      return v;
    }) as typeof selectRows.shift;

    const outcome = await runSentryPull({ projectId: PROJECT });

    expect(outcome.status).toBe('failed');
    expect(outcome.output).toMatch(/refused: Sentry issue A-1 has 3 event\(s\)/);
    expect(outcome.output).toMatch(/lookup exploded/);
  });
});

describe('F1 — the listing stops at a bound and SAYS it stopped', () => {
  it('carries an incomplete listing into the run record by name', async () => {
    bindingFound();
    creatorFound();
    listSentryIssuesMock.mockResolvedValue({
      result: { deliveryId: 'del-1', durationMs: 5 },
      target: TARGET,
      issues: [],
      refused: [],
      pages: 10,
      truncated: true,
    });

    const outcome = await runSentryPull({ projectId: PROJECT });

    expect(outcome.output).toMatch(
      /INCOMPLETE: this target holds more unresolved issues than one tick reads \(10 page\(s\) of 100\)/,
    );
    // and it names the remedies that EXIST, rather than two this schedule cannot offer
    expect(outcome.output).toMatch(/give this target a narrower projectSlug/);
    expect(outcome.output).toMatch(/does not resume where it stopped/);
  });
});

describe('F5 — a long record is KEPT, because the record is the point of the record', () => {
  it('keeps every named refusal however long the list, rather than trimming the tail', async () => {
    bindingFound();
    creatorFound();
    const many = Array.from({ length: 400 }, (_, i) =>
      issue({ id: String(i), shortId: `LONG-ISSUE-SHORTID-NUMBER-${i}`, count: 1 }),
    );
    for (const _ of many) selectRows.push([]);
    answers(many);

    const outcome = await runSentryPull({ projectId: PROJECT });

    expect(outcome.output.length).toBeGreaterThan(16_000);
    expect(outcome.output).not.toMatch(/TRUNCATED/);
    // the FIRST and the LAST refusal are both there — a trim would take one of them
    expect(outcome.output).toMatch(/LONG-ISSUE-SHORTID-NUMBER-0 has 1 event/);
    expect(outcome.output).toMatch(/LONG-ISSUE-SHORTID-NUMBER-399 has 1 event/);
    // and the summary is still the first line
    expect(outcome.output.split('\n')[0]).toMatch(/issue\(s\) filed/);
  });

  it('puts a target failure ABOVE the per-issue detail, where a person reads', async () => {
    bindingFound();
    creatorFound();
    listSentryIssuesMock.mockRejectedValue(new Error('Sentry answered HTTP 500'));

    const outcome = await runSentryPull({ projectId: PROJECT });
    const lines = outcome.output.split('\n');

    expect(lines[0]).toMatch(/issue\(s\) filed/);
    expect(lines[1]).toMatch(/target forge-core: Sentry answered HTTP 500/);
  });
});

// ── The SECOND whole-set read, at the head the first round's fixes made. Five more, all real. ────

describe('F3 second round — an absent count must not erase an established baseline', () => {
  it('carries the last known count forward when this sighting carries none', async () => {
    bindingFound();
    creatorFound();
    selectRows.push([{ id: 'iss-1', metadata: { sentry: { shortId: 'X', count: 17 } } }]);
    selectRows.push([{ id: 'iss-1', metadata: { sentry: { shortId: 'X', count: 17 } } }]);
    answers([issue({ count: null })]);

    await runSentryPull({ projectId: PROJECT });

    const written = JSON.parse(String(updateSets[0]?.metadata ? '{}' : '{}'));
    void written;
    expect(insertedComments).toEqual([]);
    // the 17 survives, and the gap is recorded beside it rather than instead of it
    const params = (updateSets[0]?.metadata as { queryChunks?: unknown[] })?.queryChunks ?? [];
    const json = params.find((c): c is string => typeof c === 'string' && c.includes('"sentry"'));
    expect(JSON.parse(String(json)).sentry.count).toBe(17);
    expect(JSON.parse(String(json)).sentry.countMissingAt).toBeTruthy();
  });

  it('still reports growth after a gap, because the baseline was never lost', async () => {
    bindingFound();
    creatorFound();
    // the row as the gap tick above would have left it: count 17 kept, countMissingAt set
    const after = { sentry: { shortId: 'X', count: 17, countMissingAt: '2026-09-17T00:00:00Z' } };
    selectRows.push([{ id: 'iss-1', metadata: after }]);
    selectRows.push([{ id: 'iss-1', metadata: after }]);
    answers([issue({ count: 41 })]);

    await runSentryPull({ projectId: PROJECT });

    expect(insertedComments).toHaveLength(1);
    expect(String(insertedComments[0]?.body)).toContain('- Events: 41 (was 17)');
  });
});

describe('F1 second round — both writes of an observation go through ONE transaction', () => {
  it('opens a transaction and issues the comment and the metadata write inside it', async () => {
    bindingFound();
    creatorFound();
    selectRows.push([{ id: 'iss-1', metadata: { sentry: { count: 17 } } }]);
    selectRows.push([{ id: 'iss-1', metadata: { sentry: { count: 17 } } }]);
    answers([issue({ count: 41 })]);

    await runSentryPull({ projectId: PROJECT });

    expect(transactions).toHaveLength(1);
    expect(insertedComments).toHaveLength(1);
    expect(updateSets).toHaveLength(1);
  });

  it('re-reads the row inside the transaction rather than trusting the pre-gate lookup', async () => {
    bindingFound();
    creatorFound();
    // the pre-gate lookup sees a stale 17; the locked re-read sees the 41 another observer landed
    selectRows.push([{ id: 'iss-1', metadata: { sentry: { count: 17 } } }]);
    selectRows.push([{ id: 'iss-1', metadata: { sentry: { count: 41 } } }]);
    answers([issue({ count: 41 })]);

    await runSentryPull({ projectId: PROJECT });

    // judged against the LOCKED value, so the other observer's comment is not duplicated
    expect(insertedComments).toEqual([]);
  });

  it('opens NO transaction for an issue that was never filed', async () => {
    bindingFound();
    creatorFound();
    selectRows.push([]);
    answers([issue()]);
    await runSentryPull({ projectId: PROJECT });
    expect(transactions).toEqual([]);
  });
});

describe('F2 second round — a listing that failed part way keeps what it had decided', () => {
  it('reports the confinement refusals made before the failure, by name', async () => {
    bindingFound();
    creatorFound();
    const { SentryListingFailed } = await import('./listing.js');
    listSentryIssuesMock.mockRejectedValue(
      new SentryListingFailed('sentry: GET … — Sentry answered HTTP 500', {
        pages: 2,
        refused: [
          { issueId: '2', shortId: 'B-2', belongsTo: 'forge-web', reason: 'belongs to forge-web' },
        ],
      }),
    );

    const outcome = await runSentryPull({ projectId: PROJECT });

    expect(outcome.status).toBe('failed');
    expect(outcome.output).toMatch(
      /listing failed after 2 page\(s\), with 1 decision\(s\) already made/,
    );
    expect(outcome.output).toMatch(/confined out B-2: belongs to forge-web/);
    // and the failure itself is still reported — the partial does not soften it
    expect(outcome.output).toMatch(/Sentry answered HTTP 500/);
  });
});

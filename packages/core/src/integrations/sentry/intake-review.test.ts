/**
 * ISS-1085 slice 3 — the six findings the whole-set review of the landing head raised, each one
 * real, each one fixed, and each one with the assertion that would have caught it.
 *
 * Its own file because `intake.test.ts` reached the 500-line budget. These cases are separated by
 * what they are FOR rather than by what they touch: every one of them is a case my own tests did
 * not have until somebody else read the diff, which is worth keeping visible.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executed: string[] = [];
const updateSets: Record<string, unknown>[] = [];
const insertedComments: Record<string, unknown>[] = [];
const selectRows: unknown[][] = [];

vi.mock('../../db/client.js', () => ({
  db: {
    execute: (q: unknown) => {
      executed.push(JSON.stringify(q));
      return Promise.resolve(executeAnswer.shift() ?? [{ id: 'new-issue-1' }]);
    },
    select: () => ({
      from: () => ({
        where: () => {
          const rows = selectRows.shift() ?? [];
          const p = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: (n: number) => Promise<unknown[]>;
          };
          p.limit = () => Promise.resolve(rows);
          return p;
        },
      }),
    }),
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
  },
}));

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
    // cm:guard the COLUMN LIST is asserted whole, not `toContain('metadata')`. A first attempt at
    // this test passed against a statement whose column was renamed `metadata_unused`, because that
    // string contains `metadata` too — the mocked db validates no column name, so a loose assertion
    // here covers nothing at all.
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
    answers([issue({ count: 17 })]);

    await runSentryPull({ projectId: PROJECT });

    expect(insertedComments).toEqual([]);
  });

  // cm:guard the case the old code got wrong: metadata that has NEVER held a sighting. Before the
  // baseline went into the insert this was every newly filed issue, and `previous === null` was read
  // as growth, so the tick after filing always posted a note saying the error had got worse.
  it('posts NO comment where no sighting was ever recorded, rather than treating null as growth', async () => {
    bindingFound();
    creatorFound();
    selectRows.push([{ id: 'iss-1', metadata: null }]);
    answers([issue({ count: 17 })]);

    await runSentryPull({ projectId: PROJECT });

    expect(insertedComments).toEqual([]);
    expect(updateSets).toHaveLength(1);
  });
});

describe('F2 — the two writes an observation makes, and the order between them', () => {
  it('writes the comment BEFORE the counts, so a failed comment is retried and not lost', async () => {
    const order: string[] = [];
    bindingFound();
    creatorFound();
    selectRows.push([{ id: 'iss-1', metadata: { sentry: { count: 17 } } }]);
    answers([issue({ count: 41 })]);
    // record the order the two statements reach the db
    const realPush = insertedComments.push.bind(insertedComments);
    insertedComments.push = ((...a: Record<string, unknown>[]) => {
      order.push('comment');
      return realPush(...a);
    }) as typeof insertedComments.push;
    const realSet = updateSets.push.bind(updateSets);
    updateSets.push = ((...a: Record<string, unknown>[]) => {
      order.push('metadata');
      return realSet(...a);
    }) as typeof updateSets.push;

    await runSentryPull({ projectId: PROJECT });

    expect(order).toEqual(['comment', 'metadata']);
  });

  it('OBSERVES the row that won a race instead of throwing the sighting away', async () => {
    bindingFound();
    creatorFound();
    selectRows.push([]); // findFiled: nothing yet
    selectRows.push([{ id: 'iss-1', metadata: { sentry: { count: 17 } } }]); // the winner, reloaded
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
      /INCOMPLETE: stopped after 10 page\(s\) and Sentry had more\. Issues past that point were not seen this tick/,
    );
  });
});

describe('F5 — a record too long to store says what it dropped', () => {
  it('puts the failures above the detail and names the truncation rather than trailing off', async () => {
    bindingFound();
    creatorFound();
    const many = Array.from({ length: 400 }, (_, i) =>
      issue({ id: String(i), shortId: `LONG-ISSUE-SHORTID-NUMBER-${i}`, count: 1 }),
    );
    for (const _ of many) selectRows.push([]);
    answers(many);

    const outcome = await runSentryPull({ projectId: PROJECT });

    expect(outcome.output.length).toBeLessThanOrEqual(16_000);
    expect(outcome.output).toMatch(/TRUNCATED at 16000 characters\. \d+ more character\(s\)/);
    // the summary is still the first line — the knife falls on the tail, never the head
    expect(outcome.output.split('\n')[0]).toMatch(/issue\(s\) filed/);
  });
});

/**
 * ISS-845 (owner, 2026-10-31, REQ-79 r6): a pass judged at an ancestor counts at a later landing,
 * recorded as carried with what changed between; a reopen voids only the criterion that was not
 * passing. Planted from adminhub-api ISS-78, whose fix round 11 landed two files on and lost 237 of
 * 452 verdicts: every pass at round 10's landing read "judged another build" at round 11's.
 *
 * The release hold's landing weighing (`criteria-basis.ts:landingCriteriaReports`) and the steward's
 * facts read the descent from Forge's own records (`recorded-holding.ts`, the issue's earlier mark
 * among them) and ask the host nothing; the record door reads the files between from the source
 * host and refuses a pass covering one of them. Against real Postgres.
 *
 * @direct-test-of packages/core/src/release-batch/landed-build-holds.ts
 * @direct-test-of packages/core/src/issues/landed-carriage.ts
 * @direct-test-of packages/core/src/issues/standing-on.ts
 * @direct-test-of packages/core/src/requirements/standing-identity.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { standingCriteriaOf } from '../../src/issues/index.js';
import { landingCriteriaReports } from '../../src/release-batch/criteria-basis.js';
import { stewardReleaseFacts } from '../../src/release-batch/index.js';
import { api } from '../helpers/api.js';
import { seedIssueStatus } from '../helpers/factories.js';
import { agreedRequirement, bcOf, traced } from '../helpers/landed-requirement.js';
import {
  BRANCH,
  landedIssue,
  ok,
  readingsOf,
  record,
  seedLandedWorld,
  world,
} from '../helpers/landed-world.js';

/** Round 10's landing, round 11's two files on, and a commit no landing was recorded at. */
const L1 = 'a78a000000000000000000000000000000000010';
const L2 = 'a78a000000000000000000000000000000000011';
const UNMARKED = 'a78a0000000000000000000000000000000000ff';
const CHANGED = ['src/billing/invoice.ts', 'src/billing/tax.ts'];
const short = (sha: string) => sha.slice(0, 12);

const planted = vi.hoisted(() => ({ host: false }));

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>();
  const holds: Record<string, readonly string[]> = {
    a78a000000000000000000000000000000000010: ['a78a000000000000000000000000000000000010'],
    a78a000000000000000000000000000000000011: [
      'a78a000000000000000000000000000000000011',
      'a78a000000000000000000000000000000000010',
    ],
  };
  const host = {
    fullName: 'adminhub/api',
    compare: async (base: string, head: string) =>
      base === head ? 'identical' : holds[head]?.includes(base) ? 'ahead' : 'diverged',
    compareFiles: async (base: string, head: string) =>
      holds[head]?.includes(base)
        ? {
            status: 'ahead',
            files: ['src/billing/invoice.ts', 'src/billing/tax.ts'],
            changes: [],
          }
        : { why: `no planted history between ${base} and ${head}` },
    readRange: async () => ({ ok: true, complete: true, commits: [{ sha: 'x' }] }),
  };
  return {
    ...real,
    ancestrySourceFor: async () =>
      planted.host
        ? { kind: 'host', host, reader: real.hostReader(host as never) }
        : { kind: 'none', why: 'no read path may ask the host here' },
  };
});

beforeEach(async () => {
  planted.host = false;
  await seedLandedWorld({ verdictsRequired: true });
});

/** A verdict by QA on criterion `n`, at a commit or (runtime) a served build, covering `covers`. */
async function judge(
  issueId: string,
  n: number,
  word: 'pass' | 'fail',
  at: string,
  opts: { covers?: string[]; runtime?: boolean } = {},
) {
  const [criterion] = (await db.execute(sql`
    SELECT id FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
  `)) as unknown as Array<{ id: string }>;
  const covers = opts.covers
    ? sql`ARRAY[${sql.join(
        opts.covers.map((c) => sql`${c}`),
        sql`, `,
      )}]::text[]`
    : sql`NULL`;
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    runtime_ref, covers, author_user_id, author_agency, judge)
    VALUES (${criterion?.id}, ${issueId}, ${word}, ${`${word} at ${at}`},
            ${opts.runtime ? 'runtime' : 'commit'}, ${opts.runtime ? null : at},
            ${opts.runtime ? at : null}, ${covers}, ${world.ownerId}, 'agent', 'qa')
  `);
}

/** The fail reopens the issue, as the move history records it, and it is taken up again. */
async function reopen(issueId: string) {
  await seedIssueStatus(issueId, 'reopen');
  await db.execute(sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source)
    VALUES ('issue', ${issueId}, 'awaiting_release', 'reopen', 'user', 'agent', ${world.ownerId}, 'issues')
  `);
  await seedIssueStatus(issueId, 'in_progress');
  await db.execute(sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source)
    VALUES ('issue', ${issueId}, 'reopen', 'in_progress', 'user', 'agent', ${world.ownerId}, 'issues')
  `);
}

/** Round 10 failed criterion `failing`: the issue reopens, is rebuilt, and is re-marked at L2. */
async function fixRound(issueId: string, failing: number) {
  await judge(issueId, failing, 'fail', L1);
  await reopen(issueId);
  await ok(api(world.token, 'DELETE', `/api/issues/${issueId}/merge`));
  await ok(
    api(world.token, 'POST', `/api/issues/${issueId}/merge`, { target: BRANCH, commit: L2 }),
  );
  await judge(issueId, failing, 'pass', L2);
  await seedIssueStatus(issueId, 'awaiting_release');
}

const statements = (n: number) => Array.from({ length: n }, (_, i) => `Criterion ${i + 1} holds`);

describe('ISS-78 round 11: a fix round landing two files on keeps every pass of round 10', () => {
  it('counts all 107 criteria at L2: 106 carried from L1 by Forge’s records, the refixed one at L2', async () => {
    const issue = await landedIssue(78, L1, statements(107));
    for (let n = 1; n <= 107; n++) await judge(issue, n, 'pass', L1);
    await fixRound(issue, 107);

    const [report] = await landingCriteriaReports(world.projectId, [issue]);

    expect(report?.landing).toBe(L2);
    expect(report?.unearned).toEqual([]);
    expect(report?.counted).toHaveLength(107);
    const carried = report?.counted.filter((c) => c.carried) ?? [];
    expect(carried.map((c) => c.criterion)).toEqual(Array.from({ length: 106 }, (_, i) => i + 1));
    expect(carried[0]?.carried).toBe(
      `carried from \`${short(L1)}\` to \`${short(L2)}\`, which descends from it (Forge recorded \`${short(L1)}\` landing on its branch before \`${short(L2)}\`); what changed between them was not read`,
    );
    expect(report?.counted.find((c) => c.criterion === 107)).toEqual({ criterion: 107, at: L2 });
    // the steward reads the same carriage: nothing is missing, no judge is owed at L2
    expect(await stewardReleaseFacts(world.projectId, issue)).toContain('No evidence is missing');
  });

  it('earns nothing on a read path for a pass covering a path, since no host is asked what changed', async () => {
    const issue = await landedIssue(78, L1, statements(3));
    await judge(issue, 1, 'pass', L1);
    await judge(issue, 2, 'pass', L1, { covers: ['src/billing/'] });
    await fixRound(issue, 3);

    const [report] = await landingCriteriaReports(world.projectId, [issue]);

    expect(report?.counted.map((c) => c.criterion)).toEqual([1, 3]);
    expect(report?.unearned).toHaveLength(1);
    expect(report?.unearned[0]?.why).toContain(
      'and it covers `src/billing/`: what changed between them was not read',
    );
  });

  it('earns nothing for a pass at a commit no landing was recorded at, saying descent was not read', async () => {
    const issue = await landedIssue(78, L1, statements(2));
    await judge(issue, 1, 'pass', UNMARKED);
    await fixRound(issue, 2);

    const [report] = await landingCriteriaReports(world.projectId, [issue]);

    expect(report?.unearned).toHaveLength(1);
    expect(report?.unearned[0]?.why).toContain(
      `nor was it read that \`${short(L2)}\` descends from it: no merge mark records the landing ${short(UNMARKED)}`,
    );
  });

  it('records L2 naming the two files, and refuses the pass covering one of them by name', async () => {
    const issue = await landedIssue(78, L1, statements(3));
    await judge(issue, 1, 'pass', L1);
    await judge(issue, 2, 'pass', L1, { covers: ['src/billing/tax.ts'] });
    await fixRound(issue, 3);
    planted.host = true;

    const res = await record([issue], L2);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(readingsOf(res.body)).toContain(
      `ISS-78: 3 live criteria, c1 pass at \`${short(L1)}\`, which \`${short(L2)}\` holds (the recorded commit adds 1 commit and changes 2 files: \`${CHANGED[0]}\`, \`${CHANGED[1]}\`); c2 no pass: it was judged at \`${short(L1)}\`, and \`${short(L2)}\` changes 1 file: \`src/billing/tax.ts\` since then, under what it covers (\`src/billing/tax.ts\`); c3 pass at \`${short(L2)}\``,
    );
  });
});

describe('a verdict names what it covers through its write door', () => {
  it('stores the prefixes it was sent, and refuses one outside the repository by name', async () => {
    const issue = await landedIssue(80, L1, statements(1));
    const body = { criterion: 1, verdict: 'pass', identity: { kind: 'commit', sha: L1 } };

    const kept = await api(world.token, 'POST', `/api/issues/${issue}/verdicts`, {
      ...body,
      covers: ['src/billing/', 'src/billing/'],
    });
    const refused = await api(world.token, 'POST', `/api/issues/${issue}/verdicts`, {
      ...body,
      covers: ['../secrets'],
    });
    const none = await api(world.token, 'POST', `/api/issues/${issue}/verdicts`, {
      ...body,
      covers: [],
    });

    expect(kept.status, JSON.stringify(kept.body)).toBe(201);
    const rows = (await db.execute(sql`
      SELECT covers FROM criterion_verdicts WHERE issue_id = ${issue}::uuid
    `)) as unknown as Array<{ covers: string[] | null }>;
    expect(rows).toEqual([{ covers: ['src/billing/'] }]);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(
      'a covers entry is a path prefix relative to the repository root',
    );
    expect(none.status).toBe(400);
    expect(JSON.stringify(none.body)).toContain('covers names at least one path prefix');
  });
});

describe('a reopen voids only the criterion that was not passing', () => {
  it('keeps the passes judged before the reopen and voids the failed criterion', async () => {
    const issue = await landedIssue(79, L1, statements(3));
    await judge(issue, 1, 'pass', L1, { runtime: true });
    await judge(issue, 2, 'pass', L1, { runtime: true });
    await judge(issue, 3, 'fail', L1, { runtime: true });
    await reopen(issue);

    const criteria = (await standingCriteriaOf([issue])).get(issue)?.criteria ?? [];

    expect(criteria.map((c) => [c.criterion, c.verdict?.verdict, c.verdict?.unverified])).toEqual([
      [1, 'pass', null],
      [2, 'pass', null],
      [3, 'fail', expect.stringContaining('when this criterion was not passing')],
    ]);
  });
});

describe('a requirement reads the carriage its issue’s release reads', () => {
  it('counts a pass at round 10’s landing at round 11’s, as the release does, naming the carriage', async () => {
    const req = await agreedRequirement(['Invoices total their lines', 'Tax is added once']);
    const issue = await landedIssue(78, L1, statements(2));
    await traced(req, issue, 78, { 1: 'BC-1', 2: 'BC-2' });
    await judge(issue, 1, 'pass', L1);
    await fixRound(issue, 2);

    const [report] = await landingCriteriaReports(world.projectId, [issue]);
    expect(report?.counted.map((c) => c.criterion)).toEqual([1, 2]);

    const carried = await bcOf(req, 'BC-1');
    expect(carried.verdict).toBe('passing');
    expect(carried.issues[0]?.notCounted).toBeNull();
    expect(carried.issues[0]?.identity).toBe(
      `judged at commit ${short(L1)}, carried from \`${short(L1)}\` to \`${short(L2)}\`, which descends from it (Forge recorded \`${short(L1)}\` landing on its branch before \`${short(L2)}\`); what changed between them was not read`,
    );
    expect(await bcOf(req, 'BC-2')).toMatchObject({ verdict: 'passing' });
  });

  it('does not carry a covering pass where what changed was not read, as the release does not', async () => {
    const req = await agreedRequirement(['Invoices total their lines', 'Tax is added once']);
    const issue = await landedIssue(78, L1, statements(2));
    await traced(req, issue, 78, { 1: 'BC-1', 2: 'BC-2' });
    await judge(issue, 1, 'pass', L1, { covers: ['src/billing/'] });
    await fixRound(issue, 2);

    const [report] = await landingCriteriaReports(world.projectId, [issue]);
    const bc = await bcOf(req, 'BC-1');

    expect(bc.verdict).toBe('not_judged');
    expect(bc.issues[0]?.notCounted).toBe(report?.unearned[0]?.why.split('; it needs')[0]);
    expect(bc.issues[0]?.notCounted).toContain(
      'and it covers `src/billing/`: what changed between them was not read',
    );
  });

  it('does not carry a pass at a commit no landing was recorded at, saying descent was not read', async () => {
    const req = await agreedRequirement(['Invoices total their lines', 'Tax is added once']);
    const issue = await landedIssue(78, L1, statements(2));
    await traced(req, issue, 78, { 1: 'BC-1', 2: 'BC-2' });
    await judge(issue, 1, 'pass', UNMARKED);
    await fixRound(issue, 2);

    const bc = await bcOf(req, 'BC-1');

    expect(bc.verdict).toBe('not_judged');
    expect(bc.issues[0]?.notCounted).toContain(
      `nor was it read that \`${short(L2)}\` descends from it: no merge mark records the landing ${short(UNMARKED)}`,
    );
  });
});

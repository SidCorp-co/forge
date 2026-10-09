/**
 * What QA found on 0.4.0-dev.220's release page (REQ-40 BC-5, BC-7, BC-9), through the app's own
 * routes against real Postgres, on a project with NO source host binding (forge-dev has none):
 *
 * - BC-7, BC-9: what the release requires of an admin, and its developer view's migrations,
 *   contracts, dependencies and settings, come from the range the release run reports from the box
 *   that cut it, read by the one reader (`shippedBetween`), never from a call to a source host.
 * - BC-5: the header, the Proof panel (the release record's totals) and the list under each
 *   requirement count the same carried criteria by the one rule (`criterionCountsAsPass` of the
 *   verdict on the build), a short counted and marked, a pass on an earlier build not counted.
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { backgroundRefreshesSettled } from '../../src/release-page/index.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { BUILD, MERGED, releasePageWorld } from '../helpers/release-page-world.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
const tokens: Record<'owner' | 'member' | 'agent', string> = { owner: '', member: '', agent: '' };
const fx = releaseWorld(() => ({ projectId, ownerId }));
const world = releasePageWorld(() => ({ projectId, ownerId, call, fx }));
let unplant: (() => void) | null = null;

afterEach(async () => {
  unplant?.();
  await backgroundRefreshesSettled();
});

beforeEach(async () => {
  unplant = plantLiveBuild(BUILD);
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  tokens.owner = await userToken(ownerId);
  const member = await createTestUser({ verified: true });
  await addProjectMember(projectId, member.id, 'member');
  tokens.member = await userToken(member.id);
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  tokens.agent = await patToken(agentId, [projectId], 'master');
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({
    projectId,
    ownerId,
    bindingId,
    probes: 'none',
    others: { beta: { tier: 'staging', deployment: { mode: 'external' } } },
  });
});

function call(who: keyof typeof tokens, method: 'GET' | 'POST', path: string, body?: unknown) {
  return api(tokens[who], method, `/api/projects/${projectId}${path}`, body);
}

type Proven = { code: string | null; statement: string; short: boolean; issueKey: string };
type Group = { proven: Proven[]; unproven: number };
type Page = {
  header: { verified: { level: string; proven: number; total: number } };
  requirements: Array<Group & { key: string }>;
  untraced: Group | null;
  actionRequired: Array<{ kind: string; ref: string; sentence: string }>;
  knownIssues: Array<{ issueKey: string; bc: string | null; standing: string }>;
  shipped:
    | {
        state: 'read';
        base: string;
        head: string;
        migrations: string[];
        contracts: string[];
        dependencies: string[];
        settings: Array<{ name: string; required: boolean }>;
      }
    | { state: 'unread'; why: string };
  technical: {
    migrations: string[];
    contracts: string[];
    dependencies: string[];
    settings: string[];
  } | null;
};

const page = async (view = 'user', version = '0.1.0') => {
  const r = await call('member', 'GET', `/releases/${version}/page?view=${view}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as unknown as Page;
};

const PREVIOUS = 'd'.repeat(40);
const JOURNAL = 'packages/core/drizzle/migrations/meta/_journal.json';
const OPENAPI = 'packages/core/contracts/forge-api.openapi.json';
const PKG = 'packages/core/package.json';
const COMPOSE = 'docker-compose.prod.yml';
const SOURCE = 'packages/core/src/release-page/read.ts';

const journal = (...tags: string[]) =>
  JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) });
const spec = (paths: string[]) =>
  JSON.stringify({
    paths: Object.fromEntries(paths.map((p) => [p, { get: { summary: p } }])),
    components: { schemas: {} },
  });
const env = (name: string, tail: string) => `      ${name}: \${${name}${tail}}\n`;
const compose = (...lines: string[]) => `services:\n  core:\n    environment:\n${lines.join('')}`;

/** The release shipped before this one: the range's base. */
async function earlierRelease() {
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
    VALUES (gen_random_uuid(), ${projectId}, 'system', 'completed', now() - interval '2 days', '0.0.9', now() - interval '2 days',
            ${JSON.stringify({ source: 'release-batch', finish: { requestId: 'r', state: 'finished', commit: PREVIOUS, version: 1 } })}::jsonb)
  `);
}

/** What the box that cut the release reads from its own checkout: the range adds migrations 0479..0481. */
const CHANGES = [
  { path: JOURNAL, change: 'changed' },
  { path: OPENAPI, change: 'changed' },
  { path: PKG, change: 'changed' },
  { path: COMPOSE, change: 'changed' },
  { path: SOURCE, change: 'changed' },
] as const;
const FILES = [
  {
    path: JOURNAL,
    base: journal('0477_a', '0478_b'),
    head: journal('0477_a', '0478_b', '0479_a_chat', '0480_a_rescue', '0481_a_draft'),
  },
  { path: OPENAPI, base: spec(['/api/old']), head: spec(['/api/old', '/api/previews']) },
  {
    path: PKG,
    base: JSON.stringify({ dependencies: { hono: '4.1.0' } }),
    head: JSON.stringify({ dependencies: { hono: '4.2.0', zod: '4.6.5' } }),
  },
  {
    path: COMPOSE,
    base: compose(env('DATABASE_URL', ':?set it')),
    head: compose(env('DATABASE_URL', ':?set it'), env('VAULT_KEY', ':?a key')),
  },
];

const MIGRATIONS = [
  'packages/core/drizzle/migrations/0479_a_chat.sql',
  'packages/core/drizzle/migrations/0480_a_rescue.sql',
  'packages/core/drizzle/migrations/0481_a_draft.sql',
];

describe('what a release requires is read from the range its run reports, with no source host (BC-7, BC-9)', () => {
  it('lists the migrations and the new required setting the range adds, in Action required and the developer view', async () => {
    const w = await world.releaseWorldOfFour();
    await earlierRelease();
    // the run on the box: where the range starts, which of its changed files the reader reads, then those files
    const base = await call('agent', 'GET', `/release-batches/${w.runId}/range`);
    const reads = await call('agent', 'POST', `/release-batches/${w.runId}/range/reads`, {
      changes: CHANGES,
    });
    const reported = await call('agent', 'POST', `/release-batches/${w.runId}/range`, {
      base: PREVIOUS,
      head: BUILD,
      changes: CHANGES,
      files: FILES,
    });
    const user = await page('user');
    // QA 0.4.0-dev.220: "could not be read: ... this project has no active source host binding"
    expect(user.shipped, JSON.stringify(user.shipped)).toMatchObject({
      state: 'read',
      base: PREVIOUS,
      head: BUILD,
      migrations: MIGRATIONS,
    });
    expect(user.actionRequired.map((a) => [a.kind, a.ref]).slice(0, 4)).toEqual([
      ...MIGRATIONS.map((m) => ['migration', m]),
      ['setting', 'VAULT_KEY'],
    ]);
    // QA 0.4.0-dev.220: Migrations, API contracts, Dependencies and Settings all read "None"
    const dev = await page('developer');
    expect(dev.technical?.migrations).toEqual([
      ...MIGRATIONS,
      'packages/core/drizzle/migrations/0999_reminders.sql',
    ]);
    expect(dev.technical?.contracts).toEqual(['added GET /api/previews']);
    expect(dev.technical?.dependencies).toEqual([
      'packages/core: added zod 4.6.5',
      'packages/core: hono 4.1.0 -> 4.2.0',
    ]);
    expect(dev.technical?.settings).toEqual(['VAULT_KEY (required)']);
    // the doors the run used answer as the run reads them
    expect(base.status, JSON.stringify(base.body)).toBe(200);
    expect(base.body).toMatchObject({ base: PREVIOUS });
    expect(reads.status, JSON.stringify(reads.body)).toBe(200);
    expect(reads.body.reads).toEqual([OPENAPI, JOURNAL, PKG, COMPOSE].sort());
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);
    expect(reported.body).toMatchObject({ state: 'read', migrations: MIGRATIONS });
  });

  it('says the range is unread, naming the step, where the run reported none or reported another head', async () => {
    const w = await world.releaseWorldOfFour();
    const first = await page();
    expect(first.shipped).toMatchObject({
      state: 'unread',
      why: expect.stringContaining('no release shipped before'),
    });
    await earlierRelease();
    const none = await page();
    expect(none.shipped).toMatchObject({
      state: 'unread',
      why: expect.stringContaining('forge-runner release range'),
    });
    expect(none.shipped.state === 'unread' && none.shipped.why).not.toContain('source host');
    // a report for a head this page does not describe is not this page's range
    const other = 'e'.repeat(40);
    const r = await call('agent', 'POST', `/release-batches/${w.runId}/range`, {
      base: PREVIOUS,
      head: other,
      changes: [],
      files: [],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const moved = await page();
    expect(moved.shipped).toMatchObject({
      state: 'unread',
      why: expect.stringContaining(other.slice(0, 7)),
    });
    // what the issues named still stands
    expect(moved.actionRequired.map((x) => x.ref)).toContain(
      'packages/core/drizzle/migrations/0999_reminders.sql',
    );
  });

  it('refuses a report by name: a base that is not the release before it, a file the reader needs and was not sent, one it does not read', async () => {
    const w = await world.releaseWorldOfFour();
    await earlierRelease();
    const at = `/release-batches/${w.runId}/range`;
    const moved = await call('agent', 'POST', at, {
      base: 'c'.repeat(40),
      head: BUILD,
      changes: [],
      files: [],
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(409);
    expect(JSON.stringify(moved.body)).toContain('RELEASE_RANGE_BASE_MOVED');
    expect(JSON.stringify(moved.body)).toContain(PREVIOUS.slice(0, 7));

    const missing = await call('agent', 'POST', at, {
      base: PREVIOUS,
      head: BUILD,
      changes: CHANGES,
      files: FILES.filter((f) => f.path !== JOURNAL),
    });
    expect(missing.status, JSON.stringify(missing.body)).toBe(422);
    expect(JSON.stringify(missing.body)).toContain('RELEASE_RANGE_FILE_MISSING');
    expect(JSON.stringify(missing.body)).toContain(JOURNAL);

    const extra = await call('agent', 'POST', at, {
      base: PREVIOUS,
      head: BUILD,
      changes: CHANGES,
      files: [...FILES, { path: SOURCE, base: 'a', head: 'b' }],
    });
    expect(extra.status, JSON.stringify(extra.body)).toBe(422);
    expect(JSON.stringify(extra.body)).toContain('RELEASE_RANGE_FILE_UNREAD');

    const short = await call('agent', 'POST', at, {
      base: 'abc1234',
      head: BUILD,
      changes: [],
      files: [],
    });
    expect(short.status, JSON.stringify(short.body)).toBe(400);
    // nothing refused was kept
    expect((await page()).shipped).toMatchObject({ state: 'unread' });
  });
});

describe('the header, the Proof panel and the list count one set of rows by one rule (BC-5)', () => {
  /**
   * One requirement's four criteria over two issues, plus a criterion of the second issue that
   * traces no requirement criterion, plus an issue that traces no requirement at all:
   *   a#1 pass on the build      -> proven
   *   a#2 short on the build     -> proven, marked short, and a known issue (BC-8)
   *   b#1 pass on an EARLIER build only -> not proven on this build
   *   b#2 fail on the build      -> not proven
   *   b#3 (no trace) pass on the build -> proven, listed without a code
   *   c#1 (no requirement) pass on the build -> proven, under no requirement
   */
  async function seeded() {
    const req = await world.agreedRequirement();
    const a = await fx.insertIssue('awaiting_release', {
      section: 'Added',
      userFacing: 'Nurses see a reminder before each visit.',
    });
    const b = await fx.insertIssue('awaiting_release', {
      section: 'Fixed',
      userFacing: 'A visit report keeps its filter after a reload.',
    });
    const c = await fx.insertIssue('awaiting_release', {
      section: 'Fixed',
      userFacing: 'The visit list loads faster.',
    });
    await world.traceIssue(a, req.id, [req.bc['BC-1'] as string, req.bc['BC-2'] as string]);
    await seedIssueStatus(b, 'in_progress');
    await db.execute(
      sql`UPDATE issues SET requirement_id = ${req.id}, planned_revision = 1 WHERE id = ${b}`,
    );
    await replaceCriteria(b, [
      { n: 1, statement: 'criterion 1', requirementCriterionId: req.bc['BC-3'] as string },
      { n: 2, statement: 'criterion 2', requirementCriterionId: req.bc['BC-4'] as string },
      { n: 3, statement: '(REQ-1 BC-2) the reminder names the patient' },
    ]);
    await seedIssueStatus(b, 'awaiting_release');
    await seedIssueStatus(c, 'in_progress');
    await replaceCriteria(c, [{ n: 1, statement: 'the list loads in a second' }]);
    await seedIssueStatus(c, 'awaiting_release');
    await world.judge(b, 1, 'pass', MERGED);
    const cut = await call('owner', 'POST', '/release-batches', { issueIds: [a, b, c] });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    const runId = String(cut.body.runId);
    const ask = await call('agent', 'POST', `/release-batches/${runId}/approvals`, {
      evidence: { environment: 'beta', commit: BUILD, reading: 'GET /api/health 200' },
    });
    expect(ask.status, JSON.stringify(ask.body)).toBe(201);
    await world.judge(a, 1, 'pass', BUILD);
    await world.judge(a, 2, 'short', BUILD, { reason: 'only on a desktop browser' });
    await world.judge(b, 2, 'fail', BUILD, { reason: 'the filter resets on reload' });
    await world.judge(b, 3, 'pass', BUILD);
    await world.judge(c, 1, 'pass', BUILD);
  }

  it('says the same proven and total in the header, the Proof panel and the sum of the list', async () => {
    await seeded();
    const p = await page();
    const record = await call('member', 'GET', '/releases/0.1.0');
    expect(record.status, JSON.stringify(record.body)).toBe(200);
    const panel = (record.body.release as { criteria: { proven: number; total: number } }).criteria;
    const groups: Group[] = [...p.requirements, ...(p.untraced ? [p.untraced] : [])];
    const listed = {
      proven: groups.reduce((n, g) => n + g.proven.length, 0),
      total: groups.reduce((n, g) => n + g.proven.length + g.unproven, 0),
    };
    // QA 0.4.0-dev.220: "8 of 22" in the header and the panel, 5 proven + 15 not yet proven listed
    expect({ header: p.header.verified.proven, panel: panel.proven, list: listed.proven }).toEqual({
      header: 4,
      panel: 4,
      list: 4,
    });
    expect({ header: p.header.verified.total, panel: panel.total, list: listed.total }).toEqual({
      header: 6,
      panel: 6,
      list: 6,
    });
    // a short is listed as proven with its mark; a proven criterion with no trace is still listed
    const req = p.requirements.find((r) => r.key === 'REQ-1');
    expect(req?.proven.map((x) => [x.code, x.short])).toEqual([
      ['BC-1', false],
      ['BC-2', true],
      [null, false],
    ]);
    expect(req?.unproven).toBe(2);
    expect(p.untraced).toMatchObject({ proven: [{ code: null, short: false }], unproven: 0 });
    // the pass on an earlier build is not claimed here: it reads not judged on this build
    expect(p.knownIssues.map((k) => [k.bc, k.standing])).toEqual([
      ['BC-2', 'short'],
      ['BC-3', 'not_judged'],
      ['BC-4', 'fail'],
    ]);
  });
});

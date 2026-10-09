/**
 * The release page a reader reads (REQ-40, `release-page/`): one release projected from its record
 * under one truth rule, with highlights the assistant drafts and a share that freezes it — through
 * the app's own routes, against real Postgres. The release's build is the commit its approval was
 * asked at; its two issues carry four criteria judged a pass on that build, a short on it, a pass on
 * the merged commit only, and a fail on it. The page claims only the first.
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { getStorage } from '../../src/integrations/index.js';
import { register } from '../../src/integrations/llm/registry.js';
import type { ChatMessage, ChatStreamEvent } from '../../src/integrations/llm/types.js';
import { addVerdict, replaceCriteria } from '../../src/issues/criteria/service.js';
import {
  backgroundRefreshesSettled,
  refreshReleaseHighlights,
} from '../../src/release-page/index.js';
import { api, type Body, patToken, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

const BUILD = 'e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510';
const MERGED = '3b1c2d4e5f60718293a4b5c6d7e8f90112233445';
const CLIP_BYTES = Buffer.from('webm-bytes-of-the-reminder-clip');

// the gateway model, faked at the provider seam behind the same `completeOnce` a chat turn uses
const asked: ChatMessage[][] = [];
let answers: string[] = [];
register('anthropic', () => ({
  id: 'scripted',
  defaultModel: 'scripted-model',
  async *stream(req): AsyncIterable<ChatStreamEvent> {
    asked.push(req.messages);
    yield { type: 'chunk', text: answers.shift() ?? '' };
    yield { type: 'usage', usage: { promptTokens: 90, completionTokens: 40 } };
    yield { type: 'done' };
  },
}));

const highlight = (claims: string[], body = 'Nurses see a reminder before each visit.') =>
  JSON.stringify({
    highlights: [{ requirement: 'REQ-1', title: 'Visit reminders', body, claims }],
  });

let projectId: string;
let ownerId: string;
const tokens: Record<'owner' | 'member' | 'agent', string> = { owner: '', member: '', agent: '' };
const fx = releaseWorld(() => ({ projectId, ownerId }));
let unplant: (() => void) | null = null;

afterEach(async () => {
  unplant?.();
  // a page read that found its highlights owed starts a refresh; none outlives its test
  await backgroundRefreshesSettled();
});

beforeEach(async () => {
  unplant = plantLiveBuild(BUILD);
  asked.length = 0;
  answers = [];
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

const call = (who: keyof typeof tokens, method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(tokens[who], method, `/api/projects/${projectId}${path}`, body);

const rows = async (query: ReturnType<typeof sql>) => [...(await db.execute(query))];

const keyOf = async (issueId: string) => {
  const [row] = await rows(sql`SELECT iss_seq FROM issues WHERE id = ${issueId}`);
  return `ISS-${(row as { iss_seq: number }).iss_seq}`;
};

async function agreedRequirement(): Promise<{ id: string; bc: Record<string, string> }> {
  const created = await call('owner', 'POST', '/requirements', {
    title: 'Visit reminders',
    reason: 'planted',
    criteria: [
      { body: 'A nurse sees the reminder' },
      { body: 'A nurse sees it on a phone' },
      { body: 'A doctor sees the visit report' },
      { body: 'A report keeps its filter' },
    ],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const key = String(created.body.key);
  for (const [path, body] of [
    [`/requirements/${key}/revisions/1/propose`, {}],
    [`/requirements/${key}/revisions/1/accept`, {}],
    [`/requirements/${key}/agree`, { revision: 1 }],
  ] as const) {
    const r = await call('owner', 'POST', path, body);
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
  }
  const [req] = await rows(sql`SELECT id FROM requirements WHERE project_id = ${projectId}`);
  const id = String((req as { id: string }).id);
  const bcs = await rows(
    sql`SELECT id, code FROM requirement_criteria WHERE requirement_id = ${id}`,
  );
  return { id, bc: Object.fromEntries(bcs.map((b) => [String(b.code), String(b.id)])) };
}

async function traceIssue(issueId: string, requirementId: string, bcs: string[]) {
  await seedIssueStatus(issueId, 'in_progress');
  await db.execute(
    sql`UPDATE issues SET requirement_id = ${requirementId}, planned_revision = 1 WHERE id = ${issueId}`,
  );
  await replaceCriteria(
    issueId,
    bcs.map((bc, i) => ({ n: i + 1, statement: `criterion ${i + 1}`, requirementCriterionId: bc })),
  );
  await seedIssueStatus(issueId, 'awaiting_release');
}

async function judge(
  issueId: string,
  criterion: number,
  verdict: 'pass' | 'short' | 'fail',
  sha: string,
  extra: { evidence?: string[]; reason?: string } = {},
) {
  await addVerdict({
    issue: { id: issueId, projectId },
    draft: {
      criterion,
      verdict,
      reason: extra.reason ?? null,
      identity: { kind: 'commit', sha },
      evidence: extra.evidence ?? ['vitest'],
    },
    author: { userId: ownerId, deviceId: null, agency: 'agent' },
  });
}

async function attach(issueId: string, name: string, mime: string, bytes: Buffer): Promise<string> {
  const { path } = await getStorage().put(`release-page/${issueId}/${name}`, bytes, mime);
  const [row] = await rows(sql`
    INSERT INTO issue_attachments (issue_id, uploader_id, name, path, mime, size)
    VALUES (${issueId}, ${ownerId}, ${name}, ${path}, ${mime}, ${bytes.length}) RETURNING id
  `);
  return String((row as { id: string }).id);
}

interface World {
  a: string;
  b: string;
  runId: string;
  approvalId: string;
  clipId: string;
}

/**
 * A cut release of two issues tracing one requirement's four criteria, its build the commit its
 * approval was asked at; then the verdicts recorded on that build after the cut.
 */
async function releaseWorldOfFour(): Promise<World> {
  const req = await agreedRequirement();
  const a = await fx.insertIssue('awaiting_release', {
    section: 'Added',
    userFacing: 'Nurses see a reminder before each visit.',
  });
  const b = await fx.insertIssue('awaiting_release', {
    section: 'Fixed',
    userFacing: 'A visit report keeps its filter after a reload.',
    technical: 'The filter is kept in the URL.',
  });
  await traceIssue(a, req.id, [req.bc['BC-1'] as string, req.bc['BC-2'] as string]);
  await traceIssue(b, req.id, [req.bc['BC-3'] as string, req.bc['BC-4'] as string]);
  await db.execute(sql`
    UPDATE issues SET merged_artifacts = ${JSON.stringify([
      {
        surface: 'data',
        ref: 'packages/core/drizzle/migrations/0999_reminders.sql',
        change: 'added',
      },
      { surface: 'config', ref: 'reminders.leadHours', change: 'added' },
      { surface: 'config', ref: 'shares.write', change: 'changed' },
    ])}::jsonb WHERE id = ${a}
  `);
  const clipId = await attach(a, 'reminder.webm', 'video/webm', CLIP_BYTES);
  await attach(a, 'reminder.png', 'image/png', Buffer.from('png-bytes'));
  await judge(a, 1, 'pass', BUILD, { evidence: ['reminder.png', 'reminder.webm'] });
  await judge(a, 2, 'pass', MERGED);
  await judge(b, 1, 'pass', MERGED);
  await judge(b, 2, 'pass', BUILD);
  const cut = await call('owner', 'POST', '/release-batches', { issueIds: [a, b] });
  expect(cut.status, JSON.stringify(cut.body)).toBe(201);
  const runId = String(cut.body.runId);
  const ask = await call('agent', 'POST', `/release-batches/${runId}/approvals`, {
    evidence: { environment: 'beta', commit: BUILD, reading: 'GET /api/health 200' },
  });
  expect(ask.status, JSON.stringify(ask.body)).toBe(201);
  await judge(a, 2, 'short', BUILD, { reason: 'only on a desktop browser' });
  await judge(b, 2, 'fail', BUILD, { reason: 'the filter resets on reload' });
  return { a, b, runId, approvalId: String(ask.body.id ?? ask.body.approvalId), clipId };
}

type Page = {
  view: string;
  header: {
    version: string;
    build: string | null;
    environment: { name: string | null } | null;
    approval: { required: boolean; state: string; by: { name: string } | null };
  };
  highlights: {
    state: string;
    highlights?: Array<{
      claims: string[];
      media: { name: string; kind: string; url?: string } | null;
    }>;
    refusals?: Array<{ code: string }>;
    why?: string;
  };
  requirements: Array<{
    key: string;
    proven: Array<{ code: string; statement: string }>;
    unproven: number;
  }>;
  improvements: Array<{ issueKey: string; kind: string; line: string }>;
  fixes: Array<{ issueKey: string; kind: string; line: string }>;
  actionRequired: Array<{ kind: string; ref: string; sentence: string }>;
  knownIssues: Array<{
    bc: string | null;
    standing: string;
    reason: string | null;
    elsewhere: unknown;
  }>;
  technical: { notes: Array<{ technical: string }>; migrations: string[] } | null;
  can: { share: boolean; export: boolean; approve: boolean };
};

const page = async (who: keyof typeof tokens, view = 'user', version = '0.1.0') => {
  const r = await call(who, 'GET', `/releases/${version}/page?view=${view}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as unknown as Page;
};

describe('a release page claims a criterion only with a pass verdict on the build it describes', () => {
  it('claims the pass on the build, and reads the short, the pass on the merged commit and the fail as known issues', async () => {
    await releaseWorldOfFour();
    const p = await page('member');
    expect(p.header).toMatchObject({ version: '0.1.0', build: BUILD });
    expect(p.requirements).toEqual([
      {
        key: 'REQ-1',
        title: 'Visit reminders',
        completes: false,
        proven: [{ code: 'BC-1', statement: 'A nurse sees the reminder' }],
        unproven: 3,
      },
    ]);
    expect(p.knownIssues.map((k) => [k.bc, k.standing, k.reason])).toEqual([
      ['BC-2', 'short', 'only on a desktop browser'],
      ['BC-3', 'not_judged', null],
      ['BC-4', 'fail', 'the filter resets on reload'],
    ]);
    expect(p.knownIssues[1]?.elsewhere).toEqual({ verdict: 'pass', commitSha: MERGED });
  });

  it('withdraws a claim once a later verdict on the build fails it', async () => {
    const w = await releaseWorldOfFour();
    await judge(w.a, 1, 'fail', BUILD, { reason: 'the reminder came late' });
    const p = await page('member');
    expect(p.requirements[0]?.proven).toEqual([]);
    expect(p.knownIssues.find((k) => k.bc === 'BC-1')).toMatchObject({ standing: 'fail' });
  });
});

describe('the page reads off the release record', () => {
  it('heads with version, date, where it runs, commit and who approved it, asked only where the setting asks', async () => {
    const w = await releaseWorldOfFour();
    const before = await page('member');
    expect(before.header.approval).toEqual({
      required: false,
      state: 'pending',
      by: null,
      at: null,
    });
    expect(before.header.environment).not.toBeNull();
    const decided = await call(
      'owner',
      'POST',
      `/release-batches/${w.runId}/approvals/${w.approvalId}/decision`,
      { decision: 'approve' },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const after = await page('member');
    expect(after.header.approval).toMatchObject({ required: false, state: 'approved' });
    expect(after.header.approval.by?.name).toBeTruthy();
    expect(JSON.stringify(after.header)).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it('reads improvements and fixes in user terms, and what an admin must do, naming each artifact', async () => {
    const w = await releaseWorldOfFour();
    const p = await page('member');
    expect(p.improvements).toEqual([
      { issueKey: await keyOf(w.a), kind: 'new', line: 'Nurses see a reminder before each visit.' },
    ]);
    expect(p.fixes).toEqual([
      {
        issueKey: await keyOf(w.b),
        kind: 'fixed',
        line: 'A visit report keeps its filter after a reload.',
      },
    ]);
    expect(p.actionRequired.map((x) => [x.kind, x.ref])).toEqual([
      ['migration', 'packages/core/drizzle/migrations/0999_reminders.sql'],
      ['setting', 'reminders.leadHours'],
      ['permission', 'shares.write'],
    ]);
  });

  it('adds technical notes in the developer view only, and refuses a view or a version it does not have by name', async () => {
    await releaseWorldOfFour();
    expect((await page('member', 'user')).technical).toBeNull();
    const dev = await page('member', 'developer');
    expect(dev.technical?.notes).toEqual([
      expect.objectContaining({ technical: 'The filter is kept in the URL.' }),
    ]);
    expect(dev.technical?.migrations).toEqual([
      'packages/core/drizzle/migrations/0999_reminders.sql',
    ]);
    const view = await call('member', 'GET', '/releases/0.1.0/page?view=admin');
    expect(view.status).toBe(400);
    expect(JSON.stringify(view.body)).toContain('RELEASE_PAGE_VIEW_UNKNOWN');
    const missing = await call('member', 'GET', '/releases/0.9.0/page');
    expect(missing.status).toBe(404);
    expect(JSON.stringify(missing.body)).toContain('RELEASE_PAGE_NOT_FOUND');
    const stranger = await createTestUser({ verified: true });
    const denied = await api(
      await userToken(stranger.id),
      'GET',
      `/api/projects/${projectId}/releases/0.1.0/page`,
    );
    expect([403, 404]).toContain(denied.status);
  });
});

describe('the highlights the assistant drafts from the requirements it advances', () => {
  it('drafts one highlight claiming what the build proves, with the clip QA kept of it, and redrafts only when the facts change', async () => {
    const w = await releaseWorldOfFour();
    answers = [highlight(['BC-1'])];
    expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('drafted');
    const p = await page('member');
    expect(p.highlights.state).toBe('drafted');
    expect(p.highlights.highlights).toEqual([
      expect.objectContaining({
        claims: ['BC-1'],
        media: expect.objectContaining({
          name: 'reminder.webm',
          kind: 'clip',
          url: `/api/attachments/${w.clipId}/download`,
        }),
      }),
    ]);
    const input = asked[0]?.map((m) => m.content).join('\n') ?? '';
    expect(input).toMatch(/^Claimable: BC-1$/m);
    expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('unchanged');
    expect(asked).toHaveLength(1);

    await judge(w.a, 1, 'fail', BUILD, { reason: 'the reminder came late' });
    expect((await page('member')).highlights).toMatchObject({ state: 'none' });
    expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('none');
    expect(asked).toHaveLength(1);
  });

  it('sends a refused draft back once with its refusal, then stores the refusal the page shows', async () => {
    const w = await releaseWorldOfFour();
    answers = [highlight(['BC-2']), highlight(['BC-1'], 'Nurses see 5 reminders a day.')];
    expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('refused');
    expect(asked).toHaveLength(2);
    expect(asked[1]?.at(-1)?.content).toContain('RELEASE_HIGHLIGHT_UNCLAIMED');
    const p = await page('member');
    expect(p.highlights.state).toBe('failed');
    expect(p.highlights.refusals?.map((r) => r.code)).toEqual([
      'RELEASE_HIGHLIGHT_FIGURE_UNBACKED',
    ]);
  });

  it('is redrafted through the outbox when a verdict is recorded on an issue it carries', async () => {
    // truncation restarts the outbox's seq, and a delivery's job id is built from it: the jobs an
    // earlier test of this file left would stand in for this test's own and swallow them
    await db.execute(sql`DELETE FROM pgboss_v12.job WHERE name LIKE 'outbox.%'`);
    const w = await releaseWorldOfFour();
    await startQueue();
    try {
      answers = [highlight(['BC-1']), highlight(['BC-1'])];
      await settleOutbox();
      // the world's own verdicts were delivered: one draft for their facts, the rest unchanged
      const before = asked.length;
      expect(before).toBe(1);
      const r = await api(tokens.owner, 'POST', `/api/issues/${w.b}/verdicts`, {
        criterion: 1,
        verdict: 'pass',
        identity: { kind: 'commit', sha: BUILD },
        evidence: [],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await settleOutbox();
      expect(asked.length).toBe(before + 1);
    } finally {
      await closeWorld();
    }
    const [row] = await rows(sql`SELECT state FROM release_highlights WHERE run_id = ${w.runId}`);
    expect((row as { state: string }).state).toBe('drafted');
    const p = await page('member');
    expect(p.requirements[0]?.proven.map((x) => x.code)).toEqual(['BC-1', 'BC-3']);
  });
});

describe('a release page shared by Forge link', () => {
  it('freezes the user view, and hands out each clip behind a link minted for that opening only', async () => {
    const w = await releaseWorldOfFour();
    answers = [highlight(['BC-1'])];
    expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('drafted');
    const made = await call('owner', 'POST', '/shares', {
      subjectKind: 'release',
      subjectId: '0.1.0',
      audience: 'link',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((made.body.share as Body).title).toBe('Release 0.1.0');
    const token = String(made.body.url).split('/s/')[1];
    const [kept] = await rows(
      sql`SELECT snapshot FROM share_links WHERE project_id = ${projectId}`,
    );
    const snapshot = JSON.stringify((kept as { snapshot: unknown }).snapshot);
    expect(snapshot).not.toContain('/download');
    expect(snapshot).toContain('"technical":null');

    const open = async () => {
      const r = await api(null, 'POST', '/api/shares/open', { token });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.release as Page;
    };
    const first = await open();
    expect(first.header.version).toBe('0.1.0');
    expect(first.can).toEqual({ share: false, export: true, approve: false });
    expect(first.knownIssues).toHaveLength(3);
    const url = String(first.highlights.highlights?.[0]?.media?.url);
    expect(url).toMatch(/^\/api\/uploads\/download\/[0-9a-f-]{36}$/);
    const file = await api(null, 'GET', url);
    expect(file.status).toBe(200);
    expect(String(file.body.text)).toBe(CLIP_BYTES.toString());
    const second = await open();
    expect(second.highlights.highlights?.[0]?.media?.url).not.toBe(url);
  });

  it('refuses a version the project has no release of, by name', async () => {
    await releaseWorldOfFour();
    const r = await call('owner', 'POST', '/shares', {
      subjectKind: 'release',
      subjectId: '0.9.0',
      audience: 'members',
    });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).toContain('SHARE_SUBJECT_NOT_FOUND');
  });
});

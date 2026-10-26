// GET /api/projects/:id/needs-you/decisions on the rows a live project really holds (dev.251, project
// d1bb4907): a suggestion whose payload leads with a paragraph, an issue and a requirement whose
// title runs past a decision's 500-character cap. An output schema that refused those titles once
// answered the whole list 500. The business rules under test (REQ-48 BC-11): each decision is titled
// by its record's title, never by a prose field; a title over the cap is cut at a word boundary with
// an ellipsis; a record no decision can be made of is named, never the read's failure; and the number
// of statements the read spends does not grow with the number of rows.
//
// @direct-test-of packages/core/src/development/needs-you-fold.ts
// @direct-test-of packages/core/src/development/needs-you-decisions.ts
// @direct-test-of packages/core/src/suggestions/waiting-read.ts

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
} from '../helpers/factories.js';

const TITLE_MAX = 500;
const words = (n: number, word: string) =>
  Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
/** A paragraph of prose, as an agent's suggestion note or a pasted issue title reads: ~700 characters. */
const PROSE = `${words(90, 'because')}.`;
const LONG_ISSUE_TITLE = words(80, 'checkout');
const LONG_REQUIREMENT_TITLE = words(80, 'discharge');

let ownerId = '';
let memberId = '';
let owner = '';
let member = '';

const queriesOf = (headers: Headers): number => {
  const raw = headers.get('server-timing') ?? '';
  const n = /db;dur=[0-9.]+;desc="(\d+) quer/.exec(raw)?.[1];
  if (n === undefined) throw new Error(`Server-Timing "${raw}" names no query count`);
  return Number(n);
};

const design = (projectId: string, flow: string): Doc => {
  const d: Doc = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  d.project = projectId;
  d.flow = flow;
  return d;
};

const slugOf = (id: string) =>
  [...id.replaceAll('-', '').slice(0, 16)]
    .map((c) => 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(c, 16)])
    .join('');

function expectOk(r: { status: number; body: Doc }, status = 200): Doc {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
}

/** A cut title: within the cap, a prefix of the source ending on a whole word, with an ellipsis. */
function expectCutAtWord(title: string, source: string) {
  expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
  expect(title.endsWith('…')).toBe(true);
  const kept = title.slice(0, -1);
  expect(source.startsWith(kept)).toBe(true);
  expect(source.charAt(kept.length)).toBe(' ');
}

/** `n` issues, each with a suggestion leading with prose, a mockup and a live preview, and `n` proposed requirement revisions. */
async function world(n: number, opts: { longTitles: boolean }) {
  const { id: projectId } = await createTestProject(ownerId);
  await addProjectMember(projectId, memberId, 'member');
  const at = (p: string) => `/api/projects/${projectId}${p}`;
  const deviceId = await createTestDevice(ownerId);
  const issues: { id: string; key: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const issue = await createTestIssue(projectId, ownerId, i, {
      status: 'open',
      createdAt: new Date(Date.now() - 5 * 86_400_000),
    });
    if (opts.longTitles && i === 1) {
      await db.execute(sql`UPDATE issues SET title = ${LONG_ISSUE_TITLE} WHERE id = ${issue.id}`);
    }
    issues.push(issue);
    expectOk(
      await api(member, 'POST', at('/suggestions'), {
        kind: 'triage',
        issue: issue.key,
        baseRevision: null,
        payload: { note: opts.longTitles ? PROSE : 'route this to the checkout team' },
      }),
      201,
    );
    expectOk(
      await api(member, 'POST', at('/mockups'), {
        target: { issue: issue.key },
        kind: 'html',
        name: `checkout-${i}.html`,
        mime: 'text/html',
        caption:
          'the checkout as it should look, with the basket on the left and the total under it',
        contentBase64: Buffer.from('<p>checkout</p>').toString('base64'),
      }),
      201,
    );
    const runId = await createTestRunSession(projectId, deviceId, new Date(), null);
    const previewId = randomUUID();
    await db.execute(sql`
      INSERT INTO previews (id, project_id, subject_kind, issue_id, session_id, device_id, slug, state,
                            command, idle_minutes, created_by, live_at)
      SELECT ${previewId}, ${projectId}, 'issue', ${issue.id}, s.id, ${deviceId}, ${`p-${slugOf(previewId)}`},
             'live', 'pnpm dev', 30, ${memberId}, now() - interval '1 day'
        FROM agent_sessions s WHERE s.pipeline_run_id = ${runId}`);
    const req = expectOk(
      await api(owner, 'POST', at('/requirements'), {
        title: `The case reaches its owner ${i}`,
        reason: 'the case has to reach its owner',
        criteria: [{ body: 'The case reaches its owner.' }],
      }),
      201,
    ).key as string;
    expectOk(await api(owner, 'POST', at(`/requirements/${req}/revisions/1/propose`), {}));
    if (opts.longTitles && i === 1) {
      await db.execute(sql`
        UPDATE requirements SET title = ${LONG_REQUIREMENT_TITLE}
         WHERE project_id = ${projectId} AND req_seq = ${Number(req.slice(4))}`);
    }
    const made = expectOk(
      await api(owner, 'POST', at('/workflows'), {
        baseRevision: null,
        document: design(projectId, `post-discharge-${i}`),
      }),
      201,
    );
    expectOk(
      await api(owner, 'POST', at(`/workflows/${made.document.id}/design/propose`), {
        revision: 1,
      }),
    );
    expectOk(
      await api(member, 'POST', at('/feedback'), {
        kind: 'bug',
        title: `The board loses card ${i}`,
        screen: 'The board',
      }),
      201,
    );
  }
  return { projectId, issues };
}

beforeAll(async () => {
  testEnv();
  ownerId = (await createTestUser({ verified: true })).id;
  memberId = (await createTestUser({ verified: true })).id;
  await db.execute(sql`UPDATE users SET display_name = 'Lan Nguyen' WHERE id = ${memberId}`);
  owner = await userToken(ownerId);
  member = await userToken(memberId);
}, 120_000);

afterAll(closeWorld);

const READ = (projectId: string) => `/api/projects/${projectId}/needs-you/decisions`;
const byId = (read: Doc, prefix: string) =>
  (read.decisions as Doc[]).filter((d) => d.id.startsWith(prefix));

describe('a decision is titled by its record’s title, and one long title never fails the read', () => {
  it('answers the read where a suggestion leads with prose and an issue and a requirement run past the cap', async () => {
    const w = await world(1, { longTitles: true });
    const read = expectOk(await api(owner, 'GET', READ(w.projectId)));
    expect(read.notDecisions.filter((n: Doc) => n.reason === 'unreadable')).toEqual([]);
    expect(byId(read, 'suggestion:')).toHaveLength(1);
    expect(byId(read, 'preview:')).toHaveLength(1);
    expect(byId(read, 'mockup:')).toHaveLength(1);
    for (const d of read.decisions as Doc[]) {
      expect(d.title.length, d.id).toBeLessThanOrEqual(TITLE_MAX);
      expect(d.title, `${d.id} reads prose`).not.toContain('because');
    }

    // a suggestion reads the title of the record it is on, never its payload's note
    expectCutAtWord(byId(read, 'suggestion:')[0]?.title, LONG_ISSUE_TITLE);
    // the preview reads the same issue's title, cut the same way
    expectCutAtWord(byId(read, 'preview:')[0]?.title, LONG_ISSUE_TITLE);
    // a mockup reads its name, never its caption
    expect(byId(read, 'mockup:')[0]?.title).toBe('checkout-1.html');
    // the note is the proposal's object, read beside the title and never in its place, cut at a word
    const what = byId(read, 'suggestion:')[0]?.proposal.what as string;
    expect(what.length).toBeLessThanOrEqual(600);
    expect(what.endsWith('…')).toBe(true);
    expect(PROSE.startsWith(what.slice(0, -1))).toBe(true);
  }, 120_000);

  it('names a record it cannot make a decision of beside the rest, which still answer', async () => {
    const w = await world(1, { longTitles: false });
    const made = expectOk(
      await api(member, 'POST', `/api/projects/${w.projectId}/suggestions`, {
        kind: 'triage',
        issue: w.issues[0]?.key,
        baseRevision: null,
        payload: { note: 'route this to the payments team' },
      }),
      201,
    );
    // a payload no write takes: its kind's schema refuses it, so no proposal can be read from it
    await db.execute(
      sql`UPDATE suggestions SET payload = '{}'::jsonb WHERE id = ${made.suggestion.id}`,
    );
    const read = expectOk(await api(owner, 'GET', READ(w.projectId)));
    expect(read.notDecisions).toContainEqual({
      reason: 'unreadable',
      count: 1,
      items: [
        {
          key: w.issues[0]?.key,
          title: 'issue 1',
          next: 'open it on its own page',
          opens: { kind: 'issue', key: w.issues[0]?.key },
        },
      ],
    });
    // and /needs-you lists it too: one list, counted alike (ISS-618 c3)
    const needs = expectOk(await api(owner, 'GET', `/api/projects/${w.projectId}/needs-you`));
    const asks = (needs.items as Doc[]).filter((i) => i.space === 'asks');
    expect(asks.length).toBe(
      read.total +
        read.notDecisions
          .filter((x: Doc) => x.reason !== 'agent_takes')
          .reduce((n: number, x: Doc) => n + x.count, 0),
    );
    expect(read.decisions.map((d: Doc) => d.id)).not.toContain(`suggestion:${made.suggestion.id}`);
    expect(byId(read, 'suggestion:')).toHaveLength(1);
    expect(byId(read, 'mockup:')).toHaveLength(1);
    expect(byId(read, 'preview:')).toHaveLength(1);
  }, 120_000);

  it('spends no more statements on four rows of each kind than on one', async () => {
    const one = await world(1, { longTitles: false });
    const four = await world(4, { longTitles: false });
    const a = await api(owner, 'GET', READ(one.projectId));
    const b = await api(owner, 'GET', READ(four.projectId));
    const [n1, n4] = [expectOk(a).total as number, expectOk(b).total as number];
    expect(n4).toBeGreaterThanOrEqual(n1 * 4);
    const [at1, at4] = [queriesOf(a.headers), queriesOf(b.headers)];
    console.info(`needs-you decisions read: ${at1} statements at ${n1} rows, ${at4} at ${n4} rows`);
    expect(at4, `${at1} statements at ${n1} rows, ${at4} at ${n4} rows`).toBeLessThanOrEqual(at1);
  }, 180_000);
});

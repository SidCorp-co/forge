// GET /api/projects/:id/approvals on the rows a live project really holds (dev.251, project
// d1bb4907): a suggestion whose payload leads with a paragraph, an issue and a requirement whose
// title runs past the inbox's 500-character cap. The read's own output schema refused those titles and
// the whole list answered 500. The business rules under test: each row is titled by its record's
// short title, never by a prose field; a title over the cap is cut at a word boundary with an
// ellipsis; and the number of statements the read spends does not grow with the number of rows.
//
// @direct-test-of packages/core/src/development/approvals.ts
// @direct-test-of packages/core/src/development/approvals-rows.ts
// @direct-test-of packages/core/src/suggestions/waiting-read.ts

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { APPROVAL_INBOX_MAX } from '@forge/contracts/approvals';
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

describe('an approval row is titled by its record’s short title, and one long title never fails the list', () => {
  it('answers the list where a suggestion leads with prose and an issue and a requirement run past the cap', async () => {
    const w = await world(1, { longTitles: true });
    const inbox = expectOk(await api(owner, 'GET', `/api/projects/${w.projectId}/approvals`));
    expect(inbox.unreadable).toEqual([]);
    const byKind = (k: string) => (inbox.items as Doc[]).filter((i) => i.kind === k);
    expect(byKind('suggestion')).toHaveLength(1);
    expect(byKind('preview')).toHaveLength(1);
    expect(byKind('revision')).toHaveLength(1);
    expect(byKind('mockup')).toHaveLength(1);
    for (const item of inbox.items as Doc[]) {
      expect(item.title.length, `${item.kind} ${item.key}`).toBeLessThanOrEqual(TITLE_MAX);
      expect(item.title, `${item.kind} ${item.key} reads prose`).not.toContain('because');
    }

    // a suggestion reads the title of the record it is on, never its payload's note
    const [suggestion] = byKind('suggestion');
    expectCutAtWord(suggestion?.title, LONG_ISSUE_TITLE);
    // the preview reads the same issue's title, cut the same way
    expectCutAtWord(byKind('preview')[0]?.title, LONG_ISSUE_TITLE);
    // a requirement with no short name reads its title, cut at a word
    expectCutAtWord(byKind('revision')[0]?.title, LONG_REQUIREMENT_TITLE);
    // a mockup reads its name, never its caption
    expect(byKind('mockup')[0]?.title).toBe('checkout-1.html');
    expect(suggestion?.askedBy).toEqual({ kind: 'person', name: 'Lan Nguyen' });
  }, 120_000);

  it('reads a requirement by its short name where it has one', async () => {
    const w = await world(1, { longTitles: true });
    await db.execute(sql`
      UPDATE requirements SET short_name = 'Case reaches its owner' WHERE project_id = ${w.projectId}`);
    const inbox = expectOk(await api(owner, 'GET', `/api/projects/${w.projectId}/approvals`));
    const revision = (inbox.items as Doc[]).find((i) => i.kind === 'revision');
    expect(revision?.title).toBe('Case reaches its owner');
  }, 120_000);

  it('names a row it cannot build beside the rest, which still answer', async () => {
    const w = await world(1, { longTitles: false });
    const asker = (await createTestUser({ verified: true })).id;
    await addProjectMember(w.projectId, asker, 'member');
    // a name past the row's 200-character bound: no write takes one, so the row is not built from it
    await db.execute(sql`UPDATE users SET display_name = ${'n'.repeat(260)} WHERE id = ${asker}`);
    const made = expectOk(
      await api(await userToken(asker), 'POST', `/api/projects/${w.projectId}/suggestions`, {
        kind: 'triage',
        issue: w.issues[0]?.key,
        baseRevision: null,
        payload: { note: 'route this to the payments team' },
      }),
      201,
    );
    const inbox = expectOk(await api(owner, 'GET', `/api/projects/${w.projectId}/approvals`));
    expect(inbox.unreadable).toEqual([
      {
        kind: 'suggestion',
        id: `suggestion:${made.suggestion.id}`,
        key: w.issues[0]?.key,
        opens: { kind: 'issue', key: w.issues[0]?.key },
        problem: expect.stringContaining('askedBy.name'),
      },
    ]);
    expect((inbox.items as Doc[]).map((i) => i.kind).sort()).toEqual([
      'design',
      'mockup',
      'preview',
      'revision',
      'suggestion',
    ]);
    expect(inbox.total).toBe(6);
  }, 120_000);

  it('spends no more statements on four rows of each kind than on one', async () => {
    const one = await world(1, { longTitles: false });
    const four = await world(4, { longTitles: false });
    const a = await api(owner, 'GET', `/api/projects/${one.projectId}/approvals`);
    const b = await api(owner, 'GET', `/api/projects/${four.projectId}/approvals`);
    expect(expectOk(a).items).toHaveLength(5);
    expect(expectOk(b).items).toHaveLength(20);
    expect(expectOk(b).items.length).toBeLessThanOrEqual(APPROVAL_INBOX_MAX);
    const [at1, at4] = [queriesOf(a.headers), queriesOf(b.headers)];
    console.info(`approvals read: ${at1} statements at 5 rows, ${at4} at 20 rows`);
    expect(at4, `${at1} statements at 5 rows, ${at4} at 20 rows`).toBeLessThanOrEqual(at1);
  }, 180_000);
});

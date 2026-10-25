/**
 * REQ-70 BC-2 and BC-3 on the release page, through the app's own routes against real Postgres: every
 * highlight shows a picture or clip from QA evidence, and every change reads as a short title and one
 * sentence. The release is the page's own world (`release-page-world.ts`): one requirement, a clip and
 * a picture QA kept of BC-1, the build the commit its approval was asked at.
 *
 * @direct-test-of packages/core/src/release-page/draft.ts
 * @direct-test-of packages/core/src/release-page/highlights.ts
 * @direct-test-of packages/core/src/release-page/refresh.ts
 * @direct-test-of packages/contracts/src/customer-notes.ts
 * @direct-test-of packages/contracts/src/release-notes.ts
 * @direct-test-of packages/core/src/release-batch/queries.ts
 * @direct-test-of packages/core/src/release-page/share-source.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { register } from '../../src/integrations/llm/registry.js';
import type { ChatMessage, ChatStreamEvent } from '../../src/integrations/llm/types.js';
import { warnedReleaseNotes } from '../../src/release-batch/index.js';
import {
  backgroundRefreshesSettled,
  refreshReleaseHighlights,
} from '../../src/release-page/index.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { BUILD, releasePageWorld } from '../helpers/release-page-world.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

// the gateway model, faked at the provider seam: only a highlight draft (its input lists what is
// `Claimable:`) is recorded and scripted, so `asked` and `answers` speak of highlights alone
const asked: ChatMessage[][] = [];
let answers: string[] = [];
const draftsHighlights = (messages: readonly ChatMessage[]) =>
  messages.some((m) => typeof m.content === 'string' && /^Claimable: /m.test(m.content));
register('openai', () => ({
  id: 'scripted',
  defaultModel: 'scripted-model',
  async *stream(req): AsyncIterable<ChatStreamEvent> {
    const highlights = draftsHighlights(req.messages);
    if (highlights) asked.push(req.messages);
    yield { type: 'chunk', text: highlights ? (answers.shift() ?? '') : '' };
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
const world = releasePageWorld(() => ({ projectId, ownerId, call, fx }));
const { judge, releaseWorldOfFour } = world;
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

function call(who: keyof typeof tokens, method: 'GET' | 'POST', path: string, body?: unknown) {
  return api(tokens[who], method, `/api/projects/${projectId}${path}`, body);
}

const keyOf = async (issueId: string) => {
  const [row] = [...(await db.execute(sql`SELECT iss_seq FROM issues WHERE id = ${issueId}`))];
  return `ISS-${(row as { iss_seq: number }).iss_seq}`;
};

type Page = {
  highlights: {
    state: string;
    highlights?: Array<{
      claims: string[];
      media: { name: string } | null;
      mediaGap?: string | null;
    }>;
    refusals?: Array<{ code: string }>;
  };
  improvements: Array<{ issueKey: string; line: string; detail: string | null }>;
  fixes: Array<{ issueKey: string; line: string; detail: string | null }>;
  withoutNotes: Array<{ issueKey: string; why: string }>;
};

const page = async (who: keyof typeof tokens, view = 'user') => {
  const r = await call(who, 'GET', `/releases/0.1.0/page?view=${view}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as unknown as Page;
};

// REQ-70 BC-2: 0.4.0-dev.317 on dev opened on one highlight that showed nothing but "No clip". A
// highlight is now refused when nothing QA kept shows it, a page never carries a mediaGap, and a
// highlight kept that way under the earlier rule is drafted again rather than shown.
describe('every highlight shows a picture or clip from QA evidence (REQ-70 BC-2)', () => {
  it('refuses a highlight of a claim QA kept nothing of, telling the drafter which one it may pick', async () => {
    const w = await releaseWorldOfFour();
    // BC-3 now passes on the build too, with no clip or picture cited
    await judge(w.b, 1, 'pass', BUILD);
    answers = [highlight(['BC-3']), highlight(['BC-3'])];
    expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('refused');
    const input = asked[0]?.map((m) => m.content).join('\n') ?? '';
    expect(input).toMatch(/^Claimable: BC-1, BC-3$/m);
    expect(input).toMatch(/^Shown by: a clip or picture QA kept of BC-1$/m);
    expect(asked[1]?.at(-1)?.content).toContain('RELEASE_HIGHLIGHT_MEDIA_MISSING');
    const p = await page('member');
    expect(p.highlights.state).toBe('failed');
    expect(p.highlights.refusals?.map((r) => r.code)).toEqual(['RELEASE_HIGHLIGHT_MEDIA_MISSING']);
    expect(JSON.stringify(p)).not.toContain('mediaGap');
  });

  it('asks no model where QA kept no clip or picture at all, and drafts once the QA agent records one', async () => {
    const w = await releaseWorldOfFour();
    // the newest pass on BC-1 cites no file, so nothing the build proves has a clip or picture
    await judge(w.a, 1, 'pass', BUILD);
    expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('refused');
    expect(asked).toHaveLength(0);
    const bare = await page('member');
    expect(bare.highlights.state).toBe('failed');
    expect(bare.highlights.refusals?.map((r) => r.code)).toEqual(['RELEASE_HIGHLIGHTS_NO_MEDIA']);

    await judge(w.a, 1, 'pass', BUILD, { evidence: ['reminder.png', 'reminder.webm'] });
    answers = [highlight(['BC-1'])];
    expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('drafted');
    expect((await page('member')).highlights.highlights?.[0]?.media?.name).toBe('reminder.webm');
  });

  it('never shows a highlight kept with no clip under the earlier rule, and drafts it again for the same facts', async () => {
    const w = await releaseWorldOfFour();
    answers = [highlight(['BC-1'])];
    expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('drafted');
    await db.execute(sql`
      UPDATE release_highlights
      SET highlights = jsonb_build_array(
        (highlights -> 0) || '{"media": null, "mediaGap": "QA kept no clip or picture as evidence of BC-1 on this build"}'::jsonb
      )
      WHERE run_id = ${w.runId}
    `);
    const stale = await page('member');
    expect(stale.highlights.state).toBe('pending');
    expect(JSON.stringify(stale)).not.toContain('mediaGap');
    await backgroundRefreshesSettled();
    answers = [highlight(['BC-1'])];
    expect(await refreshReleaseHighlights(projectId, w.runId)).not.toBe('unchanged');
    expect((await page('member')).highlights.highlights?.[0]?.media?.name).toBe('reminder.webm');
  });
});

// REQ-70 BC-3: 477 notes on dev were written before titles, and 49 waiting to ship say two or more
// sentences. Each change reads as a short title and one sentence: a note owing either waits, named,
// until its writer fixes it, and a note written now is refused for two sentences rather than 500 characters.
describe('each change reads as a short title and one sentence (REQ-70 BC-3)', () => {
  it('holds a legacy untitled note and a two-sentence note off the page, named, until each is fixed', async () => {
    const w = await releaseWorldOfFour();
    await db.execute(sql`
      UPDATE issues SET release_notes = ${JSON.stringify({ section: 'Added', userFacing: 'Nurses see a reminder before each visit.' })}::jsonb
      WHERE id = ${w.a}
    `);
    await db.execute(sql`
      UPDATE issues SET release_notes = ${JSON.stringify({ section: 'Fixed', title: 'Report filter kept', userFacing: 'A visit report keeps its filter after a reload. It also keeps its sort.' })}::jsonb
      WHERE id = ${w.b}
    `);
    const held = await page('member', 'developer');
    expect([...held.improvements, ...held.fixes]).toEqual([]);
    expect(held.withoutNotes).toEqual([
      expect.objectContaining({ issueKey: await keyOf(w.a), why: 'untitled' }),
      expect.objectContaining({ issueKey: await keyOf(w.b), why: 'not_one_sentence' }),
    ]);

    const two = await api(tokens.owner, 'PATCH', `/api/issues/${w.b}`, {
      releaseNotes: {
        section: 'Fixed',
        title: 'Report filter kept',
        userFacing: 'A visit report keeps its filter after a reload. It also keeps its sort.',
      },
    });
    expect(two.status).toBe(400);
    expect(JSON.stringify(two.body)).toContain('userFacing has 2 sentences');
    const long = `A visit report keeps its filter ${'and its sort '.repeat(45)}after a reload.`;
    expect(long.length).toBeGreaterThan(500);
    for (const [id, notes] of [
      [
        w.a,
        {
          section: 'Added',
          title: 'Visit reminders',
          userFacing: 'Nurses see a reminder before each visit.',
        },
      ],
      [w.b, { section: 'Fixed', title: 'Report filter kept', userFacing: long }],
    ] as const) {
      const r = await api(tokens.owner, 'PATCH', `/api/issues/${id}`, { releaseNotes: notes });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const fixed = await page('member', 'developer');
    expect(fixed.improvements.map((c) => [c.line, c.detail])).toEqual([
      ['Visit reminders', 'Nurses see a reminder before each visit.'],
    ]);
    expect(fixed.fixes.map((c) => [c.line, c.detail])).toEqual([['Report filter kept', long]]);
    expect(fixed.withoutNotes).toEqual([]);
  });
});

// The coordinator's ruling on REQ-70: a release that ended is history. On dev, 22 shipped pages kept a
// highlight with no clip and 471 notes on old pages have no title; none may change because the rule
// tightened after they shipped, while the same record on a release still to ship is held or refused.
const KEPT_GAP = 'QA kept no clip or picture as evidence of BC-1 on this build';
const planted = async (w: { a: string; b: string; runId: string }) => {
  await db.execute(sql`
    UPDATE release_highlights
    SET highlights = jsonb_build_array((highlights -> 0) || ${JSON.stringify({ media: null, mediaGap: KEPT_GAP })}::jsonb)
    WHERE run_id = ${w.runId}
  `);
  await db.execute(sql`
    UPDATE issues SET release_notes = ${JSON.stringify({ section: 'Added', userFacing: 'Nurses see a reminder before each visit.' })}::jsonb
    WHERE id = ${w.a}
  `);
  await db.execute(sql`
    UPDATE issues SET release_notes = ${JSON.stringify({ section: 'Fixed', title: 'Report filter kept', userFacing: 'A visit report keeps its filter after a reload. It also keeps its sort.' })}::jsonb
    WHERE id = ${w.b}
  `);
};
// a ship stamp is what makes a release shipped (`release-batch/versions.ts:versionStatus`)
const shipRun = (runId: string) =>
  db.execute(sql`UPDATE pipeline_runs SET release_released_at = now() WHERE id = ${runId}`);

describe('a release that ended keeps the page it ended with (REQ-70, history)', () => {
  it('holds a no-clip highlight and an untitled note on a release still to ship, and reads both unchanged once it shipped', async () => {
    const w = await releaseWorldOfFour();
    answers = [highlight(['BC-1'])];
    expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('drafted');
    await planted(w);

    // awaiting approval: the rule holds
    const open = await page('member', 'developer');
    expect(open.highlights.state).toBe('pending');
    expect(JSON.stringify(open)).not.toContain('mediaGap');
    expect(open.withoutNotes.map((n) => n.why)).toEqual(['untitled', 'not_one_sentence']);
    await backgroundRefreshesSettled();

    // shipped: it reads as it was kept, and nothing drafts it again
    answers = [];
    await shipRun(w.runId);
    await db.execute(sql`
      UPDATE release_highlights
      SET state = 'drafted', source_digest = 'the digest it shipped with', refusals = '[]'::jsonb,
          highlights = jsonb_build_array(${JSON.stringify({ requirement: { key: 'REQ-1', title: 'Visit reminders' }, title: 'Visit reminders', body: 'Nurses see a reminder before each visit.', claims: ['BC-1'], media: null, mediaGap: KEPT_GAP })}::jsonb)
      WHERE run_id = ${w.runId}
    `);
    const asks = asked.length;
    const ended = await page('member', 'developer');
    expect(ended.highlights.state).toBe('drafted');
    expect(ended.highlights.highlights?.[0]).toMatchObject({ media: null, mediaGap: KEPT_GAP });
    expect(ended.improvements.map((c) => [c.line, c.detail])).toEqual([
      ['Nurses see a reminder before each visit.', null],
    ]);
    expect(ended.fixes.map((c) => [c.line, c.detail])).toEqual([
      [
        'Report filter kept',
        'A visit report keeps its filter after a reload. It also keeps its sort.',
      ],
    ]);
    expect(ended.withoutNotes).toEqual([]);
    expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('ended');
    await backgroundRefreshesSettled();
    expect(asked).toHaveLength(asks);
  });

  it('opens a share frozen with a highlight that says it has no clip, as it was frozen', async () => {
    const w = await releaseWorldOfFour();
    answers = [highlight(['BC-1'])];
    expect(await refreshReleaseHighlights(projectId, w.runId)).toBe('drafted');
    const made = await call('owner', 'POST', '/shares', {
      subjectKind: 'release',
      subjectId: '0.1.0',
      audience: 'link',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const token = String(made.body.url).split('/s/')[1];
    // a share is frozen by trigger; this plants the shape one frozen before REQ-70 BC-2 holds
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`
        UPDATE share_links
        SET snapshot = jsonb_set(snapshot, '{highlights,highlights,0}', (snapshot #> '{highlights,highlights,0}') || ${JSON.stringify({ media: null, mediaGap: KEPT_GAP })}::jsonb)
        WHERE project_id = ${projectId}
      `);
    });
    const r = await api(null, 'POST', '/api/shares/open', { token });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const frozen = r.body.release as Page;
    expect(frozen.highlights.highlights?.[0]).toMatchObject({ media: null, mediaGap: KEPT_GAP });
  });

  it('names a note that needs one sentence while its release is still open, and lets the master fix it before review', async () => {
    const w = await releaseWorldOfFour();
    await planted(w);
    const [a, b] = [await keyOf(w.a), await keyOf(w.b)];
    expect(await warnedReleaseNotes(projectId, 'en')).toEqual([
      expect.objectContaining({ key: a, release: '0.1.0', problems: ['note needs a short title'] }),
      expect.objectContaining({
        key: b,
        release: '0.1.0',
        problems: ['note needs one sentence (it says 2)'],
      }),
    ]);
    await shipRun(w.runId);
    expect(await warnedReleaseNotes(projectId, 'en')).toEqual([]);
  });
});

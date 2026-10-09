/**
 * REQ-41 r1 BC-19, BC-20 (docs/proposals/chat-first.md "Diagnosis", "Confirm"): the assistant reads
 * what a reproduce recorded as its timeline only and proposes a cause and a fix that the item's own
 * issue route carries; the reporter's Fixed or Not fixed, said in the fix's preview, is the item's
 * loop close once that same change ships, and asks again where what shipped is not what they saw.
 * Deleting the item's reporter data deletes its recordings. Core on a throwaway Postgres.
 */

import { BUILD_THE_FIX, type RecordingToolResult } from '@forge/contracts/reproduce';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import type { McpContext } from '../../src/lib/tool.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
} from '../helpers/factories.js';
import { passingReport } from '../helpers/merge-check-report.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

type Who = 'owner' | 'ann' | 'bo' | 'stranger';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let deviceId = '';
const people = {} as Record<Who, string>;
const at = (path: string) => `/api/projects/${projectId}${path}`;
const DAY = 86_400_000;

const P = 'a'.repeat(40);
const Q = 'b'.repeat(40);
const BUILD = 'c'.repeat(40);
const MERGED = 'd'.repeat(40);
let seq = 100;

// FB-52 as it was reproduced on dev: the order form's Save answered 500 and the page logged it
const FB52_TIMELINE = [
  { at: 0, kind: 'navigate', text: 'Opened https://shop.test/orders/new' },
  { at: 0, kind: 'viewport', text: 'Window 1280×720' },
  { at: 2100, kind: 'input', text: 'Typed in a field (masked)' },
  { at: 3400, kind: 'click', text: 'Clicked Save order' },
  { at: 3520, kind: 'request_failed', text: 'POST https://shop.test/api/orders answered 500' },
  { at: 3530, kind: 'console_error', text: 'console.error: Order save failed: 500' },
];

const slug = () =>
  `p-${Array.from({ length: 16 }, () => 'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(Math.random() * 32)]).join('')}`;

const feedbackId = async (key: string) =>
  (
    (await db.execute(
      sql`SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${Number(key.slice(3))}`,
    )) as unknown as { id: string }[]
  )[0]?.id as string;

/** A reproduce preview of `fb` with one stopped recording holding `timeline`. */
async function recorded(fb: string, by: string, timeline = FB52_TIMELINE): Promise<string> {
  const fid = await feedbackId(fb);
  const [p] = (await db.execute(sql`
    INSERT INTO previews (project_id, subject_kind, subject, checkout, feedback_id, device_id, slug, command, idle_minutes, created_by)
    VALUES (${projectId}, 'reproduce',
            ${JSON.stringify({ kind: 'reproduce', feedback: fb, build: { sha: BUILD, release: '1.4.0' }, record: true })}::jsonb,
            ${JSON.stringify({ kind: 'reproduce', repoPath: '/srv/shop', path: '/srv/shop/.claude/worktrees/r', sha: BUILD })}::jsonb,
            ${fid}, ${deviceId}, ${slug()}, 'npm run dev', 30, ${by})
    RETURNING id
  `)) as unknown as { id: string }[];
  const [r] = (await db.execute(sql`
    INSERT INTO preview_recordings (project_id, feedback_id, preview_id, build_sha, build_release, recorded_by, state, events, bytes, segments, timeline, stopped_at, expires_at)
    VALUES (${projectId}, ${fid}, ${p?.id}, ${BUILD}, '1.4.0', ${by}, 'stopped', 42, 2048,
            ${JSON.stringify([`recordings/${projectId}/x/000000.json.gz`])}::jsonb, ${JSON.stringify(timeline)}::jsonb,
            now(), now() + interval '30 days')
    RETURNING id
  `)) as unknown as { id: string }[];
  return r?.id as string;
}

/**
 * An issue that shipped at MERGED, carrying a new item ann reported, with an issue preview the
 * reporter (or `by`) confirmed on `patch`; the merge check at MERGED recorded `shipped` (or none).
 */
async function shippedWithConfirm(args: {
  patch: string;
  shipped: string | null;
  verdict: 'fixed' | 'not_fixed';
  by?: Who;
  note?: string;
}): Promise<string> {
  seq += 1;
  const issue = await createTestIssue(projectId, people.owner, seq, {
    status: 'closed',
    createdAt: new Date(Date.now() - 3 * DAY),
    mergedAt: new Date(Date.now() - DAY),
  });
  await db.execute(sql`UPDATE issues SET merged_commit_sha = ${MERGED} WHERE id = ${issue.id}`);
  const fb = await createTestFeedback(projectId, people.ann, seq, [issue.id]);
  const fid = await feedbackId(fb);
  // one preview per run session: each issue's run is its own
  const runId = await createTestRunSession(projectId, deviceId, new Date(), null);
  const [session] = (await db.execute(
    sql`SELECT id FROM agent_sessions WHERE pipeline_run_id = ${runId}`,
  )) as unknown as { id: string }[];
  const [p] = (await db.execute(sql`
    INSERT INTO previews (project_id, subject_kind, issue_id, session_id, device_id, slug, command, idle_minutes, created_by)
    VALUES (${projectId}, 'issue', ${issue.id}, ${session?.id}, ${deviceId}, ${slug()}, 'npm run dev', 30, ${people.owner})
    RETURNING id
  `)) as unknown as { id: string }[];
  await db.execute(sql`
    INSERT INTO preview_fix_confirmations (project_id, feedback_id, preview_id, patch_id, verdict, note, by, at)
    VALUES (${projectId}, ${fid}, ${p?.id}, ${args.patch}, ${args.verdict}, ${args.note ?? null},
            ${people[args.by ?? 'ann']}, now() - interval '2 days')
  `);
  const { writeCoreRecord } = await import('../../src/issues/record-events/store.js');
  const { recordFields } = await import('../../src/issues/merge-check-rules.js');
  const report = passingReport({
    base: { branch: 'main', sha: 'e'.repeat(40) },
    head: MERGED,
    touched: [{ path: 'web/orders.tsx', change: 'changed' }],
    lane: 'full',
    // `shipped: null` is an old-shape full-lane report: it sent no patch id, so the record says absent
    patchId: args.shipped ?? undefined,
  });
  await writeCoreRecord(db, {
    issueId: issue.id,
    actor: { type: 'device', id: deviceId, agency: 'agent' },
    kind: 'verification',
    fields: recordFields(report),
  });
  return fb;
}

const read = async (fb: string, who: Who = 'owner'): Promise<Doc> =>
  ok(await say(who, 'GET', at(`/feedback/${fb}`))).feedback;

const chat = (who: Who) =>
  ({
    principal: { kind: 'session', userId: people[who], agency: 'human' },
  }) as unknown as McpContext;

async function recordingTool(
  who: Who,
  args: Record<string, unknown>,
): Promise<RecordingToolResult> {
  const { forgeRecordingTool } = await import('../../src/feedback/index.js');
  return (await forgeRecordingTool(chat(who)).handler({
    projectId,
    ...args,
  })) as RecordingToolResult;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const tokens = {} as Record<Who, string>;
  for (const who of ['owner', 'ann', 'bo', 'stranger'] as const) {
    people[who] = (await createTestUser({ verified: true })).id;
    tokens[who] = await signUserToken(people[who]);
  }
  projectId = (await createTestProject(people.owner)).id;
  await addProjectMember(projectId, people.ann, 'member');
  await addProjectMember(projectId, people.bo, 'member');
  deviceId = await createTestDevice(people.owner);
  say = requester(app, tokens);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('the assistant reads the recording and proposes a cause and a fix (BC-19)', () => {
  it("answers FB-52's recording as its timeline, never its raw events", async () => {
    const fb = await createTestFeedback(projectId, people.ann, 52);
    const recording = await recorded(fb, people.ann);
    const out = await recordingTool('bo', { feedback: fb });
    expect(out.feedback).toMatchObject({ key: 'FB-52', phase: 'new' });
    expect(out.recordings).toHaveLength(1);
    expect(out.recordings[0]).toMatchObject({
      id: recording,
      build: { sha: BUILD, release: '1.4.0' },
      timeline: FB52_TIMELINE,
      events: 42,
    });
    expect(JSON.stringify(out), 'no stored segment path, no raw event').not.toContain('json.gz');
    expect(out.proposal).toBeNull();
  });

  it('refuses a stranger by the recordings’ own name', async () => {
    await expect(recordingTool('stranger', { feedback: 'FB-52' })).rejects.toMatchObject({
      refusals: [expect.objectContaining({ code: 'RECORDING_FORBIDDEN' })],
    });
  });

  it('answers a diagnosis as the proposal with its recommended answer, pressable by who may route', async () => {
    const [recording] = (await recordingTool('owner', { feedback: 'FB-52' })).recordings;
    const diagnosis = {
      recording: recording?.id,
      cause: 'Save posts the order without its currency, and the orders API answers 500.',
      fix: 'Send the selected currency with the order, and show the API error on the form.',
    };
    const answers = {
      criterion: 'none',
      severity: 'high',
      reproduced: `Recording ${recording?.id}: Save answers 500 and the order is lost.`,
    };
    const asOwner = await recordingTool('owner', { feedback: 'FB-52', diagnosis, answers });
    expect(asOwner.proposal).toEqual({
      diagnosis,
      answers,
      recommended: BUILD_THE_FIX,
      pressable: true,
      why: null,
    });
    const asMember = await recordingTool('bo', { feedback: 'FB-52', diagnosis, answers });
    expect(asMember.proposal?.pressable).toBe(false);
    expect(asMember.proposal?.why).toContain('feedback.approve');
  });

  // REQ-34 BC-2: the agent's door is a triage like the others, so it proposes none it cannot answer
  it('refuses a diagnosis with no triage answers, naming each question the press would be refused on', async () => {
    const [recording] = (await recordingTool('owner', { feedback: 'FB-52' })).recordings;
    const diagnosis = { recording: recording?.id, cause: 'Save drops the currency.', fix: 'Send it.' };
    const refused = await recordingTool('owner', { feedback: 'FB-52', diagnosis }).then(
      () => null,
      (err: { refusals: Doc[] }) => err.refusals,
    );
    expect(refused?.[0]).toMatchObject({ code: 'CHECKLIST_INCOMPLETE', path: '/answers' });
    for (const question of [
      'Which business criterion does it violate, or none?',
      'How severe is it?',
      'Was it reproduced, and with what evidence?',
    ]) {
      expect(refused?.[0]?.detail).toContain(question);
    }
  });

  it("refuses a diagnosis read from another item's recording", async () => {
    const other = await createTestFeedback(projectId, people.ann, 53);
    const foreign = await recorded(other, people.ann);
    await expect(
      recordingTool('owner', {
        feedback: 'FB-52',
        diagnosis: { recording: foreign, cause: 'x', fix: 'y' },
      }),
    ).rejects.toMatchObject({
      refusals: [expect.objectContaining({ code: 'FEEDBACK_DIAGNOSIS_INVALID' })],
    });
  });

  it('the pressed answer files the issue carrying the cause and the fix, the recording as evidence', async () => {
    const [recording] = (await recordingTool('owner', { feedback: 'FB-52' })).recordings;
    const diagnosis = {
      recording: recording?.id,
      cause: 'Save posts the order without its currency.',
      fix: 'Send the selected currency with the order.',
    };
    const off = await say('owner', 'POST', at('/feedback/FB-52/triage'), {
      answers: TRIAGE_ANSWERS,
      route: 'answer',
      answer: 'Known.',
      diagnosis,
    });
    expect(off.status, JSON.stringify(off.json)).toBe(422);
    expect(JSON.stringify(off.json)).toContain('FEEDBACK_DIAGNOSIS_INVALID');

    const routed = ok(
      await say('owner', 'POST', at('/feedback/FB-52/triage'), { answers: TRIAGE_ANSWERS, route: 'issue', diagnosis }),
    ).feedback;
    expect(routed.route).toMatchObject({ route: 'issue' });
    expect((routed.route.carriers as Doc[])[0]?.key).toMatch(/^[A-Z]+-\d+$/);
    const [issue] = (await db.execute(sql`
      SELECT i.description FROM feedback_route_issues r JOIN issues i ON i.id = r.issue_id
       WHERE r.feedback_id = ${await feedbackId('FB-52')}
    `)) as unknown as { description: string }[];
    expect(issue?.description).toContain(`**Cause** (from recording ${recording?.id} of FB-52)`);
    expect(issue?.description).toContain('Send the selected currency with the order.');
    expect((routed.decisions as Doc[]).at(-1)?.reason).toBe(
      'Cause: Save posts the order without its currency. Fix: Send the selected currency with the order.',
    );
  });
});

describe("the reporter's confirm in the fix preview is the item's loop close (BC-20)", () => {
  it('verifies the item as the reporter when the change a full-lane merge check shipped is the one they confirmed', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const fb = await shippedWithConfirm({ patch: P, shipped: P, verdict: 'fixed' });
    expect((await read(fb)).phase).toBe('resolved');
    const swept = await sweepResolvedFeedback();
    expect(swept.confirmed).toBeGreaterThanOrEqual(1);
    const out = await read(fb);
    expect(out.status).toBe('verified');
    expect(out.verified).toMatchObject({ how: 'person', by: people.ann, byReporter: true });
    const last = (out.decisions as Doc[]).at(-1);
    expect(last).toMatchObject({
      decision: 'verified',
      decidedBy: people.ann,
      decidedAgency: 'human',
    });
    expect(last?.reason).toMatch(
      /^Confirmed fixed in the preview of ISS-\d+ \(patch aaaaaaaaaaaa\) on \d{4}-\d{2}-\d{2}, and that change shipped$/,
    );
  });

  it('names a member who confirmed on the reporter’s behalf', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const fb = await shippedWithConfirm({ patch: P, shipped: P, verdict: 'fixed', by: 'bo' });
    await sweepResolvedFeedback();
    const out = await read(fb);
    expect(out.status).toBe('verified');
    expect((out.decisions as Doc[]).at(-1)).toMatchObject({ decidedBy: people.bo });
    expect((out.decisions as Doc[]).at(-1)?.reason).toContain('on behalf of the reporter');
  });

  it('asks again as today when what a full-lane check shipped is not what they confirmed', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const fb = await shippedWithConfirm({ patch: P, shipped: Q, verdict: 'fixed' });
    await sweepResolvedFeedback();
    const out = await read(fb);
    expect(out.status).toBe('triaged');
    expect(out.phase).toBe('resolved');
    expect(
      out.autoVerify,
      'dated: the window counts, the reporter is asked as today',
    ).toMatchObject({
      windowDays: 7,
    });
  });

  it('asks again when the merge check record that shipped it names no patch (an old-shape full-lane report: the absent marker)', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const fb = await shippedWithConfirm({ patch: P, shipped: null, verdict: 'fixed' });
    await sweepResolvedFeedback();
    expect((await read(fb)).status).toBe('triaged');
  });

  it('reopens with their note on a Not fixed said of the change that shipped', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const fb = await shippedWithConfirm({
      patch: P,
      shipped: P,
      verdict: 'not_fixed',
      note: 'Save still fails when the currency is EUR.',
    });
    const swept = await sweepResolvedFeedback();
    expect(swept.reopened).toBeGreaterThanOrEqual(1);
    const out = await read(fb);
    expect(out.status).toBe('reopened');
    expect((out.decisions as Doc[]).at(-1)).toMatchObject({
      decision: 'reopened',
      decidedBy: people.ann,
    });
    expect((out.decisions as Doc[]).at(-1)?.reason).toContain(
      'Save still fails when the currency is EUR.',
    );
  });

  it('does not reopen on a Not fixed said of a change that did not ship', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const fb = await shippedWithConfirm({
      patch: P,
      shipped: Q,
      verdict: 'not_fixed',
      note: 'Still broken.',
    });
    await sweepResolvedFeedback();
    expect((await read(fb)).status).toBe('triaged');
  });
});

describe("deleting the reporter's data deletes the recordings", () => {
  it('redacts every recording of the item, its timeline with it', async () => {
    seq += 1;
    const fb = await createTestFeedback(projectId, people.ann, seq);
    const recording = await recorded(fb, people.ann);
    ok(await say('owner', 'DELETE', at(`/feedback/${fb}/reporter-data`)));
    const [row] = (await db.execute(
      sql`SELECT state, timeline, segments FROM preview_recordings WHERE id = ${recording}`,
    )) as unknown as { state: string; timeline: unknown[]; segments: unknown[] }[];
    expect(row).toMatchObject({ state: 'redacted', timeline: [], segments: [] });
    const out = await recordingTool('owner', { feedback: fb });
    expect(out.recordings[0]).toMatchObject({ id: recording, state: 'redacted', timeline: [] });
  });
});

// REQ-48 BC-5, the judges' verdict on dev.270: the steward never asks again what a person already
// answered on the item, whichever question asked it (ISS-134 and ISS-284 were kept on 2026-10-14
// through the stale-draft question, and asked again), and it never asks beside a question still
// open there. One cause is diagnosed once: a requirement stuck through a carrier issue that is
// itself stuck is only noted, its note citing the carrier, and the carrier is diagnosed (REQ-45 and
// ISS-498). The standing read is a scripted one of its contract type, so each case states it.
// What the steward asks names it as the asker, and each act it took shows on the item with the
// door that undoes it, or how a person overrides it where none does (REQ-48 BC-12).
//
// @direct-test-of packages/core/src/steward/door-decide.ts
// @direct-test-of packages/core/src/steward/sweep.ts
// @direct-test-of packages/core/src/questions/read.ts
// @direct-test-of packages/core/src/steward/undo-rules.ts
// @direct-test-of packages/core/src/steward/policy.ts

import type { Said } from '@forge/contracts/said';
import type { ItemStanding } from '@forge/contracts/steward';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { resetScript, script } from '../helpers/scripted-chat.js';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/llm/chat.js')>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

let say: (who: 'owner' | 'steward', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let stewardId = '';
let standings: ItemStanding[] = [];
let diagnose: (issue: { id: string; key: string }, recommended: string) => Promise<string>;
let sweep: (now?: Date) => Promise<{ stuck: number; changed: number; paced: number }>;

const said = (text: string) => ({ key: text }) as unknown as Said;

/** A stuck standing of `kind`, since `since`, carried by `carriedBy` where it was rolled up from one. */
function stuck(
  subject: { kind: 'issue' | 'requirement'; id: string; key: string },
  since: string,
  carriedBy: string | null = null,
): ItemStanding {
  const says = { who: said('Master'), act: said('take it'), rule: said('nobody serves') };
  return {
    subject,
    title: subject.key,
    group: 'stuck',
    waitingOn: {
      kind: carriedBy ? 'agent' : 'master',
      who: carriedBy ?? 'Master',
      act: 'take it',
      rule: 'nobody serves',
      ref: carriedBy,
      dueAt: null,
      says,
    },
    note: null,
    actClass: 'master_take',
    since,
    dueAt: null,
    stuck: {
      code: 'nobody_serves',
      since,
      reason: `${subject.key} waits and no master serves this project`,
      via: carriedBy,
      says: { reason: said('no master serves this project') },
    },
    carriedBy,
    basis: `basis-${subject.key}-${since}`,
  };
}

const draft = (seq: number) =>
  createTestIssue(projectId, ownerId, seq, {
    status: 'draft',
    createdAt: new Date(Date.now() - 16 * 86_400_000),
  });

/**
 * The option ids of the merge-or-drop question Forge asked on a week-old draft before the steward
 * took that job over: its answered rows stay, and a keep on one is still read before asking.
 */
const STALE_DRAFT_OPTION_IDS = { drop: 'stale_draft.drop', keep: 'stale_draft.keep' } as const;

/** The stale-draft merge-or-drop question on `issueId`, answered keep by the owner now. */
async function keptThroughStaleDraft(issueId: string) {
  const made = ok(
    await say('owner', 'POST', '/api/questions', {
      issueId,
      prompt: 'A draft nobody has touched for 7 days. Drop it, or keep it?',
      options: [
        { id: STALE_DRAFT_OPTION_IDS.drop, label: 'Drop it' },
        { id: STALE_DRAFT_OPTION_IDS.keep, label: 'Keep it as a draft' },
      ].map((o) => ({
        ...o,
        authority: 'writer',
        bindsTo: 'this_call',
        executedBy: 'core',
        fingerprint: `stale-draft:${issueId}`,
      })),
      recommendedOptionId: STALE_DRAFT_OPTION_IDS.keep,
      blockerKind: 'human',
    }),
    201,
  );
  ok(
    await say('owner', 'POST', `/api/questions/${made.id as string}/answer`, {
      round: 1,
      optionId: STALE_DRAFT_OPTION_IDS.keep,
    }),
  );
  return made.id as string;
}

const questionsOn = (issueId: string) =>
  rows<{ id: string; status: string }>(sql`
    SELECT id, status FROM agent_questions WHERE issue_id = ${issueId} ORDER BY created_at`);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { provideStewardStandings } = await import('../../src/steward/index.js');
  provideStewardStandings(async (pid) => (pid === projectId ? standings : []));
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  stewardId = await stewardAccountOf(projectId);
  const { mintStewardCredential } = await import('../../src/steward/credential.js');
  const steward = (
    await mintStewardCredential({ projectId, stewardId, acts: ['stuck_diagnosis'], ttlMs: 600_000 })
  ).token;
  say = requester(app, { owner: await signUserToken(ownerId), steward });
  const { db } = await import('../../src/db/client.js');
  const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
  const { runGatewayAct } = await import('../../src/steward/turn.js');
  sweep = (await import('../../src/steward/sweep.js')).sweepStandings;
  diagnose = async (issue, recommended) => {
    const [made] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, not_before, started_at, ended_at)
      VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'standing.stuck', '[]'::jsonb,
              ARRAY['stuck_diagnosis']::text[], 'done', now(), now(), now())
      RETURNING id`);
    const [run] = await db
      .select()
      .from(stewardRuns)
      .where(eq(stewardRuns.id, made?.id ?? ''));
    if (!run) throw new Error('the run row was not written');
    resetScript();
    script.steps = [
      {
        tool: {
          name: 'steward_decide',
          args: { about: issue.key, recommended, why: 'nothing has moved on it since' },
        },
      },
      { text: 'Done.' },
    ];
    await runGatewayAct({ run, act: 'stuck_diagnosis', standing: null, stewardId });
    return JSON.stringify(
      (script.sent.at(-1) ?? []).filter((m) => m.role === 'tool').map((m) => m.content),
    );
  };
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("the steward reads a person's answers of every kind before it asks (REQ-48 BC-5)", () => {
  it('asks nothing on a draft a person kept through the stale-draft question since it read stuck', async () => {
    const issue = await draft(134);
    standings = [stuck({ kind: 'issue', ...issue }, '2026-10-05T00:00:00.000Z')];
    const kept = await keptThroughStaleDraft(issue.id);
    const said = await diagnose(issue, 'drop');
    expect(said).toContain(`was kept on the standing it reads now (question ${kept}`);
    expect(said).toContain('Keep it as a draft');
    expect(await questionsOn(issue.id)).toEqual([{ id: kept, status: 'answered' }]);
  });

  it('asks again where the keep was answered before the issue came to read as it does now', async () => {
    const issue = await draft(135);
    await keptThroughStaleDraft(issue.id);
    standings = [stuck({ kind: 'issue', ...issue }, new Date(Date.now() + 60_000).toISOString())];
    await diagnose(issue, 'drop');
    const open = (await questionsOn(issue.id)).filter((q) => q.status === 'open');
    expect(open).toHaveLength(1);
  });

  it('asks nothing beside a question of another kind still open on the issue', async () => {
    const issue = await draft(136);
    standings = [stuck({ kind: 'issue', ...issue }, '2026-10-05T00:00:00.000Z')];
    const made = ok(
      await say('owner', 'POST', '/api/questions', {
        issueId: issue.id,
        prompt: 'A draft nobody has touched for 7 days. Drop it, or keep it?',
        options: [
          { id: STALE_DRAFT_OPTION_IDS.drop, label: 'Drop it' },
          { id: STALE_DRAFT_OPTION_IDS.keep, label: 'Keep it as a draft' },
        ].map((o) => ({
          ...o,
          authority: 'writer',
          bindsTo: 'this_call',
          executedBy: 'core',
          fingerprint: `stale-draft:${issue.id}`,
        })),
        recommendedOptionId: STALE_DRAFT_OPTION_IDS.drop,
        blockerKind: 'human',
      }),
      201,
    );
    const said = await diagnose(issue, 'drop');
    expect(said).toContain(`question ${made.id as string} on ${issue.key} already asks it`);
    expect(await questionsOn(issue.id)).toHaveLength(1);
  });
});

describe('one cause is diagnosed once, at its carrier (REQ-48 BC-5)', () => {
  it('diagnoses the stuck carrier issue and only notes the requirement it carries', async () => {
    const carrier = await createTestIssue(projectId, ownerId, 498, {
      status: 'reopen',
      createdAt: new Date(),
    });
    const req = await createTestRequirement(projectId, 45, 'carried by a stuck issue');
    standings = [
      stuck(
        { kind: 'requirement', id: req.id, key: req.key },
        '2026-10-15T00:00:00.000Z',
        carrier.key,
      ),
      stuck({ kind: 'issue', ...carrier }, '2026-10-15T00:00:00.000Z'),
    ];
    const tally = await sweep(new Date());
    expect([tally.stuck, tally.changed]).toEqual([1, 1]);
    const emitted = await rows<{ type: string; subject: string }>(sql`
      SELECT type, payload -> 'subject' ->> 'key' AS subject FROM pipeline_outbox
       WHERE payload ->> 'projectId' = ${projectId} AND type IN ('standing.stuck', 'standing.changed')
       ORDER BY type`);
    expect(emitted).toEqual([
      { type: 'standing.changed', subject: req.key },
      { type: 'standing.stuck', subject: carrier.key },
    ]);
  });

  it('diagnoses the requirement itself where its carrier is not stuck', async () => {
    const carrier = await createTestIssue(projectId, ownerId, 499, {
      status: 'open',
      createdAt: new Date(),
    });
    const req = await createTestRequirement(projectId, 46, 'carried by a moving issue');
    standings = [
      stuck(
        { kind: 'requirement', id: req.id, key: req.key },
        '2026-10-16T00:00:00.000Z',
        carrier.key,
      ),
    ];
    const tally = await sweep(new Date());
    expect([tally.stuck, tally.changed]).toEqual([1, 0]);
  });
});

describe("the steward reads a stuck feedback item's triage proposals with its own grant (REQ-48 BC-11)", () => {
  it('lists the proposed triage on a feedback item through its viewer read, as a person does', async () => {
    const fb = await createTestFeedback(projectId, ownerId, 31);
    const [item] = await rows<{ id: string }>(sql`
      SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = 31`);
    await rows(sql`
      INSERT INTO suggestions (project_id, kind, fingerprint, producer_kind, feedback_id, payload, status)
      VALUES (${projectId}, 'feedback_triage', 'fp-fb-31', 'agent', ${item?.id ?? null},
              ${JSON.stringify({ route: 'answer', answer: 'It works as designed.' })}::jsonb, 'proposed')
      RETURNING id`);
    const path = `/api/projects/${projectId}/suggestions?feedback=${fb}&status=proposed`;
    const asSteward = await say('steward', 'GET', path);
    expect(asSteward.status, JSON.stringify(asSteward.json)).toBe(200);
    const asOwner = ok(await say('owner', 'GET', path));
    expect(asSteward.json.open).toBe(1);
    expect((asSteward.json.suggestions as unknown[]).length).toBe(
      (asOwner.suggestions as unknown[]).length,
    );
  });
});

describe("the steward's questions and acts show on their item, the Steward named (REQ-48 BC-12)", () => {
  it('records the Steward as the asker of its question, and a person as the asker of theirs', async () => {
    const issue = await draft(137);
    const kept = await keptThroughStaleDraft(issue.id);
    standings = [stuck({ kind: 'issue', ...issue }, new Date(Date.now() + 60_000).toISOString())];
    await diagnose(issue, 'drop');
    const listed = ok(await say('owner', 'GET', `/api/questions?issueId=${issue.id}`))
      .questions as { id: string; status: string; asker: unknown }[];
    const asked = listed.find((q) => q.status === 'open');
    expect(asked?.asker).toEqual({ id: stewardId, name: 'Steward', kind: 'agent' });
    expect(listed.find((q) => q.id === kept)?.asker).toMatchObject({ id: ownerId, kind: 'human' });
    const one = ok(await say('owner', 'GET', `/api/questions/${asked?.id ?? ''}`));
    expect(one.asker).toEqual({ id: stewardId, name: 'Steward', kind: 'agent' });
  });

  it('lists each act on the item with its undo door, or how to override it where none undoes it', async () => {
    const issue = await draft(138);
    standings = [stuck({ kind: 'issue', ...issue }, new Date(Date.now() + 60_000).toISOString())];
    await diagnose(issue, 'drop');
    const [run] = await rows<{ id: string }>(sql`
      SELECT id FROM steward_runs WHERE project_id = ${projectId} AND subject_key = ${issue.key}`);
    await rows(sql`
      INSERT INTO steward_acts (run_id, project_id, act, door, did)
      VALUES (${run?.id ?? ''}, ${projectId}, 'stuck_diagnosis',
              ${`POST /api/issues/${issue.id}/transition`}, ${`Moved ${issue.key} to on_hold.`})
      RETURNING id`);
    const acts = ok(
      await say('owner', 'GET', `/api/projects/${projectId}/steward-acts?subject=${issue.key}`),
    ).acts as { door: string; undo: unknown; override: string | null }[];
    const asked = acts.find((a) => a.door.endsWith('/decisions'));
    expect(asked?.undo).toMatchObject({
      door: expect.stringMatching(/^POST \/api\/questions\/.+\/void$/),
    });
    expect(asked?.override).toBeNull();
    const moved = acts.find((a) => a.door.endsWith('/transition'));
    expect(moved?.undo).toBeNull();
    expect(moved?.override).toBe(
      'Move the issue yourself: put it on hold, drop it, or send it on.',
    );
  });

  it('keeps an act on the oldest run in the list after 60 newer runs that took none', async () => {
    const issue = await draft(139);
    standings = [stuck({ kind: 'issue', ...issue }, new Date(Date.now() + 60_000).toISOString())];
    await diagnose(issue, 'drop');
    await rows(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, skip_reason, not_before, queued_at, started_at, ended_at)
      SELECT ${projectId}, 'issue', ${issue.id}, ${issue.key}, 'standing.stuck', '[]'::jsonb,
             ARRAY['stuck_diagnosis']::text[], 'skipped', 'basis_unchanged',
             now() + g * interval '1 second', now() + g * interval '1 second', NULL, now() + g * interval '1 second'
        FROM generate_series(1, 60) g
      RETURNING id`);
    const acts = ok(
      await say('owner', 'GET', `/api/projects/${projectId}/steward-acts?subject=${issue.key}`),
    ).acts as { door: string; undo: unknown }[];
    expect(acts.filter((a) => a.door.endsWith('/decisions'))).toHaveLength(1);
  });
});

describe('the sweep spends only its share of the day, oldest stuck first (REQ-48 BC-1, dev.271)', () => {
  it('raises as many stuck items as its share has room for, the longest stuck first, and paces the rest', async () => {
    const { spentSince, sweepQueued } = await import('../../src/steward/runs-store.js');
    const { sharesOf, stewardStanceOf, utcDayStart } = await import('../../src/steward/policy.js');
    const now = new Date();
    const share = sharesOf((await stewardStanceOf(projectId)).budget).sweep.gatewayTurns;
    const used =
      (await spentSince(projectId, utcDayStart(now), { sweepOnly: true })).gatewayTurns +
      (await sweepQueued(projectId, now)).gatewayTurns;
    // the sweep's share has room for exactly one more run today
    const filler = await draft(140);
    await rows(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, turns, not_before, started_at, ended_at)
      VALUES (${projectId}, 'issue', ${filler.id}, ${filler.key}, 'standing.stuck', '[]'::jsonb,
              ARRAY['stuck_diagnosis']::text[], 'done', ${share - used - 1}, now(), now(), now())
      RETURNING id`);
    const [newest, oldest, middle] = [await draft(141), await draft(142), await draft(143)];
    standings = [
      stuck(
        { kind: 'issue', ...(newest as { id: string; key: string }) },
        '2026-10-20T00:00:00.000Z',
      ),
      stuck(
        { kind: 'issue', ...(oldest as { id: string; key: string }) },
        '2026-10-01T00:00:00.000Z',
      ),
      stuck(
        { kind: 'issue', ...(middle as { id: string; key: string }) },
        '2026-10-10T00:00:00.000Z',
      ),
    ];
    const tally = await sweep(now);
    expect([tally.stuck, tally.paced]).toEqual([1, 2]);
    const emitted = await rows<{ subject: string }>(sql`
      SELECT payload -> 'subject' ->> 'key' AS subject FROM pipeline_outbox
       WHERE payload ->> 'projectId' = ${projectId} AND type = 'standing.stuck'
         AND payload -> 'subject' ->> 'key' IN (${newest?.key}, ${oldest?.key}, ${middle?.key})`);
    expect(emitted).toEqual([{ subject: oldest?.key }]);
  });
});

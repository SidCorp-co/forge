/**
 * What the orchestrator enqueues, driven through real Postgres.
 *
 * This file walked a nine-rung staged ladder until ISS-897; what it asserts now
 * is the shape that replaced it — ONE drive job at the entry status, and no job
 * at any other status the issue passes through. The negative half is the point:
 * a second job anywhere on the walk means two agents own one issue.
 *
 * No real runner is required: jobs are enqueued by the orchestrator and the
 * `jobs` rows are read directly. `applyStatusTransition` drives the issue
 * forward one status at a time, simulating what a session would do.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

// biome-ignore format: esbuild's TS transform cannot parse a line break inside import(); keep each typeof import(...) on one line
type Mods = {
  hooks: typeof import('../../src/pipeline/hooks.js').hooks;
  registerPipelineOrchestrator: typeof import('../../src/pipeline/orchestrator.js').registerPipelineOrchestrator;
  registerActivitySubscribers: typeof import('../../src/pipeline/subscribers.js').registerActivitySubscribers;
  applyStatusTransition: typeof import('../../src/issues/apply-transition.js').applyStatusTransition;
  defaultStatesConfig: typeof import('../../src/pipeline/pipeline-config-schema.js').defaultStatesConfig;
  drainOutboxOnce: typeof import('../../src/pipeline/outbox-worker.js').drainOutboxOnce;
};

type IssueRow = {
  id: string;
  projectId: string;
  status: import('../../src/db/schema.js').IssueStatus;
  reopenCount: number;
};

type JobSnapshot = {
  type: string;
  payload: { skillName?: string };
};

const DEFAULT_SKILL_NAMES = [
  'forge-triage',
  'forge-clarify',
  'forge-plan',
  'forge-code',
  'forge-review',
  'forge-test',
  'forge-fix',
  'forge-release',
] as const;

let harness: TestDatabase;
let mods: Mods;

async function insertGlobalSkill(name: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO skills (id, name, description, scope, prompt, source, content_hash)
    VALUES (${id}, ${name}, ${`integration: ${name}`}, 'global', 'noop', 'builtin', ${`hash-${id}`})
  `);
  return id;
}

async function seedProject(
  args: { statesOverride?: Record<string, { enabled?: boolean; mode?: 'auto' | 'manual' }> } = {},
) {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  await createTestProjectMember(harness.db, {
    userId: owner.id,
    projectId: project.id,
    role: 'admin',
  });

  const skillIdByName = new Map<string, string>();
  for (const name of DEFAULT_SKILL_NAMES) {
    skillIdByName.set(name, await insertGlobalSkill(name));
  }

  // Bootstrap-equivalent: one registration per mapped stage pointing at the
  // default `forge-<type>` global skill.
  // Stage→skill map mirrors the current PIPELINE_STEPS (registry.ts):
  // open→triage, confirmed→clarify, clarified→plan, approved→code,
  // developed→review, testing→test, reopen→fix, released→release.
  const stagePairs: Array<[string, string]> = [
    ['open', 'forge-triage'],
    ['confirmed', 'forge-clarify'],
    ['clarified', 'forge-plan'],
    ['approved', 'forge-code'],
    ['developed', 'forge-review'],
    ['testing', 'forge-test'],
    ['reopen', 'forge-fix'],
    ['released', 'forge-release'],
  ];
  for (const [stage, skillName] of stagePairs) {
    const skillId = skillIdByName.get(skillName);
    if (!skillId) throw new Error(`missing seeded skill ${skillName}`);
    await harness.db.execute(sql`
      INSERT INTO skill_registrations (project_id, skill_id, stage, registered_by)
      VALUES (${project.id}, ${skillId}, ${stage}, ${owner.id})
    `);
  }

  const states = { ...mods.defaultStatesConfig(), ...(args.statesOverride ?? {}) };
  // cm:guard this UPDATE REPLACES agent_config wholesale, so anything seeded at create time is gone by here — `enabled` has to be written again or `considerEnqueue` returns before it reaches dispatch and every case below asserts an empty jobs table for the wrong reason.
  const pipelineConfig = { enabled: true, states };
  await harness.db.execute(sql`
    UPDATE projects
    SET agent_config = jsonb_build_object('pipelineConfig', ${JSON.stringify(pipelineConfig)}::jsonb)
    WHERE id = ${project.id}
  `);

  return { owner, project, skillIdByName };
}

// cm:edge contract -> packages/core/src/issues/release-record-required.ts — the release note is this fixture's precondition, not scenery: `drive` walks every hop as a DEVICE, and a device close with none is refused
async function insertOpenIssue(projectId: string, createdById: string): Promise<IssueRow> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id, reopen_count, release_notes)
    VALUES (
      ${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)},
      'epic integration', 'open', 'medium', ${createdById}, 0,
      jsonb_build_object('section', 'Skip', 'userFacing', '-')
    )
  `);
  return { id, projectId, status: 'open', reopenCount: 0 };
}

async function readIssue(issueId: string): Promise<IssueRow> {
  const rows = await harness.db.execute<IssueRow>(sql`
    SELECT id, project_id AS "projectId", status, reopen_count AS "reopenCount"
    FROM issues WHERE id = ${issueId}
  `);
  const row = rows[0];
  if (!row) throw new Error(`issue ${issueId} not found`);
  return row;
}

async function jobsFor(issueId: string): Promise<JobSnapshot[]> {
  const rows = await harness.db.execute<JobSnapshot>(sql`
    SELECT type, payload FROM jobs
    WHERE issue_id = ${issueId}
    ORDER BY created_at ASC, type ASC
  `);
  return rows as unknown as JobSnapshot[];
}

/**
 * Drive one transition through the real orchestrator. Re-reads the issue
 * after each call because `autoSkipDisabledStages` may have advanced it past
 * `to` already. The orchestrator catches pg-boss errors so the test does not
 * need a running queue.
 */
// Forward order of the happy-path lifecycle, used so `drive` can tell whether
// the orchestrator's eager soft-skip already carried the issue to OR PAST a
// target stage (and the explicit drive should be a no-op rather than a
// backward transition).
const PIPELINE_ORDER: import('../../src/db/schema.js').IssueStatus[] = [
  'open',
  'confirmed',
  'clarified',
  'approved',
  'in_progress',
  'developed',
  'testing',
  'tested',
  'released',
  'closed',
];
const orderOf = (s: import('../../src/db/schema.js').IssueStatus): number => {
  const i = PIPELINE_ORDER.indexOf(s);
  return i === -1 ? Number.POSITIVE_INFINITY : i;
};

async function drive(
  issue: IssueRow,
  to: import('../../src/db/schema.js').IssueStatus,
  ownerId: string,
): Promise<IssueRow> {
  // Re-read the live status: a prior drive's outbox drain may have auto-skip
  // advanced the issue TO or PAST `to` already (e.g. unmapped/no-skill stages
  // like `deploying`/`pass`/`staging` collapse forward through the chain). If
  // the issue is already at-or-beyond the target, this drive is a no-op —
  // driving it would either throw NO_OP or move the issue BACKWARD. Skip
  // cleanly so the test's explicit walk tolerates the eager soft-skip.
  const live = await readIssue(issue.id);
  if (orderOf(live.status) >= orderOf(to)) return live;
  // cm:why this file drives the FULL status walk as a device actor, so it trips both transition-evidence rules in turn: planRequiredRule at `approved`, noWorkEvidenceRule at `developed`/`testing`. Neither plan text nor branch name is under test here — per-stage skill routing is — so each hop's precondition is seeded just before it.
  // cm:edge contract -> packages/core/src/issues/transition-evidence.ts — the trigger statuses ('approved' for plan, NO_WORK_EVIDENCE_STATUSES for branch) and the accepted evidence shapes live there; widen that set without widening this and all three fixtures fail at a hop instead of at their assertion
  if (to === 'approved') {
    await harness.db.execute(sql`
      UPDATE issues
      SET plan = COALESCE(NULLIF(TRIM(plan), ''), 'fixture plan — see cm:why above')
      WHERE id = ${live.id}
    `);
  }
  if (to === 'developed' || to === 'testing') {
    await harness.db.execute(sql`
      UPDATE issues
      SET session_context =
        COALESCE(session_context, '{}'::jsonb) || jsonb_build_object('branch', 'ISS-fixture-' || ${live.id}::text)
      WHERE id = ${live.id}
    `);
  }
  await mods.applyStatusTransition(live, to, { id: ownerId, ownerId });
  // ISS-196 — applyStatusTransition no longer emits `transition` inline; it
  // writes a pipeline_outbox row via the AFTER UPDATE trigger. Drain it so
  // the orchestrator subscriber fires and enqueues the stage's job. Drain in
  // a loop because each enqueue/skip may chain (auto-skip re-emits a
  // transition, producing more outbox rows) until the queue settles.
  let guard = 0;
  while ((await mods.drainOutboxOnce()).processed > 0 && guard++ < 20) {
    /* keep draining until no rows remain */
  }
  return await readIssue(issue.id);
}

async function emitIssueCreated(issue: IssueRow, ownerId: string): Promise<void> {
  await mods.hooks.emit('issueCreated', {
    issueId: issue.id,
    projectId: issue.projectId,
    actor: { type: 'user', id: ownerId, agency: 'human' },
    // ISS-130 — issueCreated payload now requires the inserted row's status.
    status: 'open',
    snapshot: {
      title: 'epic integration',
      description: null,
      priority: 'medium',
      category: null,
      reportedBy: ownerId,
      assigneeId: null,
      labels: [],
    },
  });
}

describe('ISS-107 per-project pipeline & skill configuration (epic)', () => {
  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';

    const [hooksMod, orchMod, subsMod, applyMod, schemaMod, outboxMod] = await Promise.all([
      import('../../src/pipeline/hooks.js'),
      import('../../src/pipeline/orchestrator.js'),
      import('../../src/pipeline/subscribers.js'),
      import('../../src/issues/apply-transition.js'),
      import('../../src/pipeline/pipeline-config-schema.js'),
      import('../../src/pipeline/outbox-worker.js'),
    ]);

    mods = {
      hooks: hooksMod.hooks,
      registerPipelineOrchestrator: orchMod.registerPipelineOrchestrator,
      registerActivitySubscribers: subsMod.registerActivitySubscribers,
      applyStatusTransition: applyMod.applyStatusTransition,
      defaultStatesConfig: schemaMod.defaultStatesConfig,
      drainOutboxOnce: outboxMod.drainOutboxOnce,
    };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    // Fresh handler set per test so the orchestrator and activity subscribers
    // never see payloads from a previous fixture.
    mods.hooks.reset();
    mods.registerPipelineOrchestrator(mods.hooks);
    mods.registerActivitySubscribers(mods.hooks);
  });

  it('enqueues ONE drive job at the entry status, and nothing at any other', async () => {
    const { owner, project } = await seedProject();
    let issue = await insertOpenIssue(project.id, owner.id);

    await emitIssueCreated(issue, owner.id);
    for (const to of ['in_progress', 'released', 'closed'] as const) {
      issue = await drive(issue, to, owner.id);
    }

    expect(issue.status).toBe('closed');
    expect(
      (await jobsFor(issue.id)).map((j) => ({ type: j.type, skillName: j.payload.skillName })),
    ).toEqual([{ type: 'drive', skillName: 'issue-flow' }]);
  });

  // cm:guard the driver skill name reaches the agent as TEXT in the prompt and is never resolved from `skill_registrations` — the fixture registers eight `forge-*` skills precisely so a resolver that started reading them would produce a different skillName here and go red.
  it('names the plugin skill, not a registered one, however many are registered', async () => {
    const { owner, project } = await seedProject();
    const issue = await insertOpenIssue(project.id, owner.id);

    await emitIssueCreated(issue, owner.id);

    const [job] = await jobsFor(issue.id);
    expect(job?.payload.skillName).toBe('issue-flow');
  });

  // cm:guard the entry stage gated to a human must enqueue NOTHING. It is the operator's one way to hold an issue before a session starts, and `dispatchAutonomous` is the only place it is honoured — the staged copy of this check went with the lane.
  it('enqueues nothing when the entry stage is gated to a human', async () => {
    const { owner, project } = await seedProject({
      statesOverride: { open: { enabled: true, mode: 'manual' } },
    });
    const issue = await insertOpenIssue(project.id, owner.id);

    await emitIssueCreated(issue, owner.id);

    expect(await jobsFor(issue.id)).toEqual([]);
  });

  it('a human moving a park `waiting` → `open` hands the issue back to the driver', async () => {
    const { owner, project } = await seedProject();
    const issue = await insertOpenIssue(project.id, owner.id);
    await harness.db.execute(
      sql`UPDATE issues SET status='waiting', waiting_kind='needs_decision' WHERE id=${issue.id}`,
    );

    // cm:why the `drive` helper is deliberately bypassed — it short-circuits when the live status is not in PIPELINE_ORDER, and `waiting` is a park that sits outside that walk, so routing through it would silently assert nothing
    const parked = await readIssue(issue.id);
    await mods.applyStatusTransition(parked, 'open', { id: owner.id, ownerId: owner.id });
    let guard = 0;
    while ((await mods.drainOutboxOnce()).processed > 0 && guard++ < 20) {
      /* keep draining until no rows remain */
    }

    expect((await readIssue(issue.id)).status).toBe('open');
    const summary = (await jobsFor(issue.id)).map((j) => ({
      type: j.type,
      skillName: j.payload.skillName,
    }));
    expect(summary).toEqual([{ type: 'drive', skillName: 'issue-flow' }]);
  });
});

/**
 * ISS-107 epic acceptance — Per-project pipeline & skill configuration.
 *
 * Cross-phase integration test that drives a full issue lifecycle through the
 * real orchestrator against real Postgres for three project configurations:
 *
 *   1. Default seed       — every stage uses the bootstrapped `forge-*` skill.
 *   2. Custom skill override — `confirmed` runs a custom skill, others default.
 *   3. Stage disabled     — `developed` is disabled; the issue soft-skips to
 *                            `testing` without a `review` job being created.
 *
 * No real runner is required: jobs are enqueued by the orchestrator and we
 * inspect the `jobs` rows + `activity_log` rows directly. `applyStatusTransition`
 * drives the issue forward one stage at a time, simulating what the runner
 * would do on success.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
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

type ActivityRow = {
  action: string;
  payload: { from?: string; to?: string };
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

describe('ISS-107 per-project pipeline & skill configuration (epic)', () => {
  let harness: TestDatabase;
  let mods: Mods;

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

  async function insertGlobalSkill(name: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO skills (id, name, description, scope, prompt, source, content_hash)
      VALUES (${id}, ${name}, ${`integration: ${name}`}, 'global', 'noop', 'builtin', ${`hash-${id}`})
    `);
    return id;
  }

  async function seedProject(
    args: {
      statesOverride?: Record<string, { enabled?: boolean; mode?: 'auto' | 'manual' }>;
    } = {},
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
    const pipelineConfig = {
      enabled: true,
      autoTriage: true,
      autoClarify: true,
      autoPlan: true,
      autoCode: true,
      autoReview: true,
      autoTest: true,
      autoFix: true,
      autoRelease: true,
      states,
    };
    await harness.db.execute(sql`
      UPDATE projects
      SET agent_config = jsonb_build_object('pipelineConfig', ${JSON.stringify(pipelineConfig)}::jsonb)
      WHERE id = ${project.id}
    `);

    return { owner, project, skillIdByName };
  }

  async function insertOpenIssue(projectId: string, createdById: string): Promise<IssueRow> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id, reopen_count)
      VALUES (
        ${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)},
        'epic integration', 'open', 'medium', ${createdById}, 0
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

  async function activityFor(issueId: string): Promise<ActivityRow[]> {
    const rows = await harness.db.execute<ActivityRow>(sql`
      SELECT action, payload FROM activity_log
      WHERE issue_id = ${issueId}
      ORDER BY created_at ASC
    `);
    return rows as unknown as ActivityRow[];
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
    'deploying',
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
      actor: { type: 'user', id: ownerId },
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

  it('fixture 1 — default seed: every stage uses the bootstrapped forge-* skill', async () => {
    const { owner, project } = await seedProject();
    let issue = await insertOpenIssue(project.id, owner.id);

    // `open` → triage (issueCreated path; status stays open until we transition).
    await emitIssueCreated(issue, owner.id);
    issue = await drive(issue, 'confirmed', owner.id); // → clarify
    issue = await drive(issue, 'clarified', owner.id); // → plan
    issue = await drive(issue, 'approved', owner.id); // → code
    issue = await drive(issue, 'in_progress', owner.id); // human-gated, no job
    issue = await drive(issue, 'developed', owner.id); // → review
    issue = await drive(issue, 'deploying', owner.id); // not mapped, no job
    issue = await drive(issue, 'testing', owner.id); // → test
    issue = await drive(issue, 'tested', owner.id); // manual gate, no job
    issue = await drive(issue, 'released', owner.id); // → release
    issue = await drive(issue, 'closed', owner.id); // terminal, no job

    expect(issue.status).toBe('closed');

    const allJobs = await jobsFor(issue.id);
    const summary = allJobs.map((j) => ({ type: j.type, skillName: j.payload.skillName }));
    expect(summary).toEqual([
      { type: 'triage', skillName: 'forge-triage' },
      { type: 'clarify', skillName: 'forge-clarify' },
      { type: 'plan', skillName: 'forge-plan' },
      { type: 'code', skillName: 'forge-code' },
      { type: 'review', skillName: 'forge-review' },
      { type: 'test', skillName: 'forge-test' },
      { type: 'release', skillName: 'forge-release' },
    ]);
  });

  it('fixture 2 — custom skill override at the plan stage (`clarified`) runs the custom skill there; defaults elsewhere', async () => {
    const { owner, project } = await seedProject();

    // Swap `clarified`'s registration (the plan stage) to a custom global skill.
    const customSkillId = await insertGlobalSkill('custom-planner');
    await harness.db.execute(sql`
      DELETE FROM skill_registrations
      WHERE project_id = ${project.id} AND stage = 'clarified'
    `);
    await harness.db.execute(sql`
      INSERT INTO skill_registrations (project_id, skill_id, stage, registered_by)
      VALUES (${project.id}, ${customSkillId}, 'clarified', ${owner.id})
    `);

    let issue = await insertOpenIssue(project.id, owner.id);
    await emitIssueCreated(issue, owner.id);
    issue = await drive(issue, 'confirmed', owner.id);
    issue = await drive(issue, 'clarified', owner.id);
    issue = await drive(issue, 'approved', owner.id);
    issue = await drive(issue, 'in_progress', owner.id);
    issue = await drive(issue, 'developed', owner.id);
    issue = await drive(issue, 'deploying', owner.id);
    issue = await drive(issue, 'testing', owner.id);
    issue = await drive(issue, 'tested', owner.id);
    issue = await drive(issue, 'released', owner.id);
    issue = await drive(issue, 'closed', owner.id);

    expect(issue.status).toBe('closed');

    const allJobs = await jobsFor(issue.id);
    const planRows = allJobs.filter((j) => j.type === 'plan');
    expect(planRows).toHaveLength(1);
    expect(planRows[0]?.payload.skillName).toBe('custom-planner');

    // Every other stage must still use the bootstrapped default.
    const nonPlan = allJobs.filter((j) => j.type !== 'plan');
    const expectedDefaults: Record<string, string> = {
      triage: 'forge-triage',
      clarify: 'forge-clarify',
      code: 'forge-code',
      review: 'forge-review',
      test: 'forge-test',
      release: 'forge-release',
    };
    for (const job of nonPlan) {
      expect(job.payload.skillName).toBe(expectedDefaults[job.type]);
    }
  });

  it('fixture 3 — `developed` disabled: issue soft-skips to `testing` with no review job + activity-log entry', async () => {
    const { owner, project } = await seedProject({
      statesOverride: { developed: { enabled: false, mode: 'auto' } },
    });

    let issue = await insertOpenIssue(project.id, owner.id);
    await emitIssueCreated(issue, owner.id);
    issue = await drive(issue, 'confirmed', owner.id);
    issue = await drive(issue, 'clarified', owner.id);
    issue = await drive(issue, 'approved', owner.id);
    issue = await drive(issue, 'in_progress', owner.id);

    // The skip is triggered on transition into the disabled stage. After this
    // call, the issue's status reflects the post-skip landing (testing).
    issue = await drive(issue, 'developed', owner.id);
    expect(issue.status).toBe('testing');

    issue = await drive(issue, 'tested', owner.id);
    issue = await drive(issue, 'released', owner.id);
    issue = await drive(issue, 'closed', owner.id);

    expect(issue.status).toBe('closed');

    const allJobs = await jobsFor(issue.id);
    const jobTypes = allJobs.map((j) => j.type);

    // The disabled stage MUST NOT produce a job for its job type.
    expect(jobTypes).not.toContain('review');
    // The downstream stage's job IS created — soft-skip lands the issue on it
    // and the orchestrator dispatches normally from there.
    expect(jobTypes).toContain('test');
    expect(allJobs.find((j) => j.type === 'test')?.payload.skillName).toBe('forge-test');

    const skipActivity = (await activityFor(issue.id)).filter(
      (r) =>
        r.action === 'issue.statusChanged' &&
        r.payload.from === 'developed' &&
        r.payload.to === 'testing',
    );
    expect(skipActivity).toHaveLength(1);
  });
});

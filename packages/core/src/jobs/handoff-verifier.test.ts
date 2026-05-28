import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const limit = vi.fn();
const where = vi.fn(() => ({ limit }));
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));

vi.mock('../db/client.js', () => ({
  db: { select },
}));

const { verifyHandoffOrSkip } = await import('./handoff-verifier.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  limit.mockReset();
  where.mockClear();
  from.mockClear();
  select.mockClear();
});

function mockProjectPolicy(policy: unknown) {
  // first `db.select(...).from(projects).where(...).limit(1)` → return agentConfig
  limit.mockResolvedValueOnce([{ agentConfig: policy }]);
}

function mockHandoffRow(found: boolean) {
  limit.mockResolvedValueOnce(found ? [{ id: 'm-1' }] : []);
}

function policyWithStage(opts: {
  stageStatus: string;
  enabled?: boolean;
  requireHandoffWrite?: boolean;
  missingMarkerPolicy?: 'fail' | 'warn' | 'silent';
}) {
  return {
    pipelineConfig: {
      states: {
        [opts.stageStatus]: {
          userPromptPolicy: {
            handoffs: {
              enabled: opts.enabled ?? true,
              requireHandoffWrite: opts.requireHandoffWrite ?? true,
              missingMarkerPolicy: opts.missingMarkerPolicy ?? 'warn',
            },
          },
        },
      },
    },
  };
}

describe('verifyHandoffOrSkip', () => {
  it('returns OK for non-handoff steps (clarify/release/custom/pm) regardless of policy', async () => {
    const r = await verifyHandoffOrSkip({
      projectId: PROJECT_ID,
      jobType: 'clarify',
      issueId: ISSUE_ID,
      pipelineRunId: RUN_ID,
      attempt: 1,
      payload: { stageStatus: 'whatever' },
      lastAssistantText: 'nothing relevant',
    });
    expect(r.ok).toBe(true);
    // No DB calls — exempt branch short-circuits.
    expect(limit).not.toHaveBeenCalled();
  });

  it('returns OK when no stageStatus on the payload (legacy job)', async () => {
    const r = await verifyHandoffOrSkip({
      projectId: PROJECT_ID,
      jobType: 'plan',
      issueId: ISSUE_ID,
      pipelineRunId: RUN_ID,
      attempt: 1,
      payload: {}, // no stageStatus
      lastAssistantText: 'whatever',
    });
    expect(r.ok).toBe(true);
  });

  it('FAILS with handoff_not_written when policy is missing (system default-on)', async () => {
    // System default flipped to enabled=true on 2026-05-29 — projects without
    // explicit `userPromptPolicy.handoffs` still get verified. To opt out a
    // project must set `enabled: false` explicitly.
    mockProjectPolicy({ pipelineConfig: { states: { approved: {} } } });
    mockHandoffRow(false);
    const r = await verifyHandoffOrSkip({
      projectId: PROJECT_ID,
      jobType: 'plan',
      issueId: ISSUE_ID,
      pipelineRunId: RUN_ID,
      attempt: 1,
      payload: { stageStatus: 'approved' },
      lastAssistantText: 'DONE',
    });
    expect(r.ok).toBe(false);
    expect(r.failureReason).toMatch(/handoff_not_written/);
  });

  it('returns OK when policy.handoffs.enabled is false', async () => {
    mockProjectPolicy(policyWithStage({ stageStatus: 'approved', enabled: false }));
    const r = await verifyHandoffOrSkip({
      projectId: PROJECT_ID,
      jobType: 'plan',
      issueId: ISSUE_ID,
      pipelineRunId: RUN_ID,
      attempt: 1,
      payload: { stageStatus: 'approved' },
      lastAssistantText: '',
    });
    expect(r.ok).toBe(true);
  });

  it('returns OK when last text ends with DONE and the handoff row exists', async () => {
    mockProjectPolicy(policyWithStage({ stageStatus: 'approved' }));
    mockHandoffRow(true);
    const r = await verifyHandoffOrSkip({
      projectId: PROJECT_ID,
      jobType: 'plan',
      issueId: ISSUE_ID,
      pipelineRunId: RUN_ID,
      attempt: 1,
      payload: { stageStatus: 'approved' },
      lastAssistantText: '...stuff\n\nDONE',
    });
    expect(r.ok).toBe(true);
    expect(r.breadcrumb).toBe('pipeline.handoff_written_ok');
  });

  it('FAILS with handoff_not_written when DONE is emitted but no row exists', async () => {
    mockProjectPolicy(policyWithStage({ stageStatus: 'approved' }));
    mockHandoffRow(false);
    const r = await verifyHandoffOrSkip({
      projectId: PROJECT_ID,
      jobType: 'plan',
      issueId: ISSUE_ID,
      pipelineRunId: RUN_ID,
      attempt: 1,
      payload: { stageStatus: 'approved' },
      lastAssistantText: 'DONE',
    });
    expect(r.ok).toBe(false);
    expect(r.failureKind).toBe('permanent');
    expect(r.failureReason).toMatch(/handoff_not_written/);
    expect(r.breadcrumb).toBe('pipeline.handoff_not_written');
  });

  it('FAILS with handoff_validation_failed when last text ends with HANDOFF_GIVE_UP', async () => {
    mockProjectPolicy(policyWithStage({ stageStatus: 'approved' }));
    // No row lookup — short-circuit on GIVE_UP.
    const r = await verifyHandoffOrSkip({
      projectId: PROJECT_ID,
      jobType: 'plan',
      issueId: ISSUE_ID,
      pipelineRunId: RUN_ID,
      attempt: 1,
      payload: { stageStatus: 'approved' },
      lastAssistantText: 'tried 3 times\n\nHANDOFF_GIVE_UP',
    });
    expect(r.ok).toBe(false);
    expect(r.failureReason).toMatch(/handoff_validation_failed/);
    expect(r.breadcrumb).toBe('pipeline.handoff_validation_failed');
  });

  it('returns OK with warning breadcrumb when marker is missing and policy=warn', async () => {
    mockProjectPolicy(
      policyWithStage({ stageStatus: 'approved', missingMarkerPolicy: 'warn' }),
    );
    const r = await verifyHandoffOrSkip({
      projectId: PROJECT_ID,
      jobType: 'plan',
      issueId: ISSUE_ID,
      pipelineRunId: RUN_ID,
      attempt: 1,
      payload: { stageStatus: 'approved' },
      lastAssistantText: 'agent forgot the marker',
    });
    expect(r.ok).toBe(true);
    expect(r.breadcrumb).toBe('pipeline.handoff_marker_missing');
  });

  it('FAILS with handoff_no_done_marker when marker is missing and policy=fail', async () => {
    mockProjectPolicy(
      policyWithStage({ stageStatus: 'approved', missingMarkerPolicy: 'fail' }),
    );
    const r = await verifyHandoffOrSkip({
      projectId: PROJECT_ID,
      jobType: 'plan',
      issueId: ISSUE_ID,
      pipelineRunId: RUN_ID,
      attempt: 1,
      payload: { stageStatus: 'approved' },
      lastAssistantText: 'no marker here',
    });
    expect(r.ok).toBe(false);
    expect(r.failureReason).toMatch(/handoff_no_done_marker/);
    expect(r.breadcrumb).toBe('pipeline.handoff_no_done_marker');
  });

  it('returns OK silently when marker is missing and policy=silent', async () => {
    mockProjectPolicy(
      policyWithStage({ stageStatus: 'approved', missingMarkerPolicy: 'silent' }),
    );
    const r = await verifyHandoffOrSkip({
      projectId: PROJECT_ID,
      jobType: 'plan',
      issueId: ISSUE_ID,
      pipelineRunId: RUN_ID,
      attempt: 1,
      payload: { stageStatus: 'approved' },
      lastAssistantText: 'no marker',
    });
    expect(r.ok).toBe(true);
    expect(r.breadcrumb).toBeUndefined();
  });

  it('returns OK when pipelineRunId is null (handoff scope unavailable)', async () => {
    mockProjectPolicy(policyWithStage({ stageStatus: 'approved' }));
    const r = await verifyHandoffOrSkip({
      projectId: PROJECT_ID,
      jobType: 'plan',
      pipelineRunId: null,
      attempt: 1,
      payload: { stageStatus: 'approved' },
      lastAssistantText: 'DONE',
    });
    expect(r.ok).toBe(true);
  });
});

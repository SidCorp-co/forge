import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sequenced SELECT responses: registerSkillForProject({ stage: null }) does
//   1. SELECT skillRegistrations (by skillId) — find the bound stage
//   2. SELECT projects.agentConfig (read pipelineConfig for the toggle check)
// The DELETE only runs when the rule allows it.
const selectQueue: unknown[][] = [];
function pushSelect(rows: unknown[]) {
  selectQueue.push(rows);
}
function buildSelectChain() {
  const rows = selectQueue.shift() ?? [];
  const final = async () => rows;
  return {
    from: () => ({
      where: () => ({
        limit: () => final(),
        then: (onFulfilled: (v: unknown) => unknown) => final().then(onFulfilled),
      }),
    }),
  };
}

const dbDelete = vi.fn(() => ({ where: () => Promise.resolve(undefined) }));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => buildSelectChain(),
    delete: dbDelete,
  },
}));

const hooksEmit = vi.fn(async () => undefined);
vi.mock('../pipeline/hooks.js', () => ({
  hooks: { emit: hooksEmit },
}));

const { SkillDeleteBlockedError, registerSkillForProject } = await import('./service.js');

beforeEach(() => {
  selectQueue.length = 0;
  dbDelete.mockClear();
  hooksEmit.mockClear();
});

describe('registerSkillForProject({ stage: null }) — SKILL_DELETE_BLOCKED_BY_AUTO_TOGGLE (ISS-238)', () => {
  it('rejects with SkillDeleteBlockedError when the corresponding auto<Stage> toggle is on', async () => {
    pushSelect([{ stage: 'developed' }]); // existing registration
    pushSelect([{ agentConfig: { pipelineConfig: { autoReview: true } } }]); // toggle ON

    await expect(
      registerSkillForProject({
        projectId: '00000000-0000-0000-0000-000000000001',
        skillId: '00000000-0000-0000-0000-000000000002',
        stage: null,
        actorUserId: '00000000-0000-0000-0000-000000000003',
      }),
    ).rejects.toBeInstanceOf(SkillDeleteBlockedError);
    expect(dbDelete).not.toHaveBeenCalled();
    expect(hooksEmit).not.toHaveBeenCalled();
  });

  it('allows the unbind when the corresponding toggle is off', async () => {
    pushSelect([{ stage: 'developed' }]);
    pushSelect([{ agentConfig: { pipelineConfig: { autoReview: false } } }]);

    const result = await registerSkillForProject({
      projectId: '00000000-0000-0000-0000-000000000001',
      skillId: '00000000-0000-0000-0000-000000000002',
      stage: null,
      actorUserId: '00000000-0000-0000-0000-000000000003',
    });
    expect(result.stage).toBeNull();
    expect(dbDelete).toHaveBeenCalledTimes(1);
    expect(hooksEmit).toHaveBeenCalledWith(
      'skillRegistered',
      expect.objectContaining({ stage: null }),
    );
  });

  it('allows the unbind when no current registration exists for that skill', async () => {
    pushSelect([]); // no registration row → skip the toggle check
    // No second SELECT — the toggle check is skipped when there is no row.

    const result = await registerSkillForProject({
      projectId: '00000000-0000-0000-0000-000000000001',
      skillId: '00000000-0000-0000-0000-000000000002',
      stage: null,
      actorUserId: '00000000-0000-0000-0000-000000000003',
    });
    expect(result.stage).toBeNull();
    expect(dbDelete).toHaveBeenCalledTimes(1);
  });

  it('exposes structured error fields for transport layers', () => {
    const err = new SkillDeleteBlockedError('developed', 'autoReview');
    expect(err.code).toBe('SKILL_DELETE_BLOCKED_BY_AUTO_TOGGLE');
    expect(err.stage).toBe('developed');
    expect(err.toggle).toBe('autoReview');
    expect(err.message).toContain("stage 'developed'");
    expect(err.message).toContain("'autoReview=true'");
  });
});

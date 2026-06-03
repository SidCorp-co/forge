import { beforeEach, describe, expect, it, vi } from 'vitest';

// Chainable mock that consumes one queued resolution per .select() terminal.
const queue: unknown[] = [];
// biome-ignore lint/suspicious/noExplicitAny: chainable mock proxy
const chain: any = {};
chain.from = () => chain;
chain.innerJoin = () => chain;
chain.where = () => chain;
chain.limit = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) =>
  Promise.resolve(queue.shift() ?? []).then(resolve, reject);

const selectSpy = vi.fn(() => chain);

vi.mock('../db/client.js', () => ({
  db: { select: selectSpy },
}));

const { issueStatuses } = await import('../db/schema.js');
const {
  STATUS_TO_JOB_TYPE,
  createProjectSkillResolver,
  inverseJobTypeToStatus,
  resolveJobTypeForStatus,
  resolveSkillForStatus,
} = await import('./skill-mapping.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queue.length = 0;
  selectSpy.mockClear();
});

describe('resolveJobTypeForStatus', () => {
  it('maps every automatable status to a jobType + toggle', () => {
    expect(resolveJobTypeForStatus('open')).toEqual({ type: 'triage', toggle: 'autoTriage' });
    expect(resolveJobTypeForStatus('confirmed')).toEqual({
      type: 'clarify',
      toggle: 'autoClarify',
    });
    expect(resolveJobTypeForStatus('clarified')).toEqual({ type: 'plan', toggle: 'autoPlan' });
    expect(resolveJobTypeForStatus('approved')).toEqual({ type: 'code', toggle: 'autoCode' });
    expect(resolveJobTypeForStatus('developed')).toEqual({ type: 'review', toggle: 'autoReview' });
    expect(resolveJobTypeForStatus('testing')).toEqual({ type: 'test', toggle: 'autoTest' });
    expect(resolveJobTypeForStatus('reopen')).toEqual({ type: 'fix', toggle: 'autoFix' });
    expect(resolveJobTypeForStatus('released')).toEqual({ type: 'release', toggle: 'autoRelease' });
  });

  it('returns null for human-gated statuses', () => {
    // needs_info is human-gated again — clarify moved to the happy path.
    for (const s of ['waiting', 'staging', 'on_hold', 'closed', 'needs_info'] as const) {
      expect(resolveJobTypeForStatus(s)).toBeNull();
    }
  });

  it('covers only automatable statuses (snapshot check against drift)', () => {
    const mapped = Object.keys(STATUS_TO_JOB_TYPE).sort();
    expect(mapped).toEqual(
      [
        'approved',
        'clarified',
        'confirmed',
        'developed',
        'open',
        'released',
        'reopen',
        'testing',
      ].sort(),
    );
    for (const key of mapped) {
      expect(issueStatuses).toContain(key as never);
    }
  });
});

describe('inverseJobTypeToStatus', () => {
  it('maps each jobType back to its source status', () => {
    expect(inverseJobTypeToStatus('triage')).toBe('open');
    expect(inverseJobTypeToStatus('clarify')).toBe('confirmed');
    expect(inverseJobTypeToStatus('plan')).toBe('clarified');
    expect(inverseJobTypeToStatus('code')).toBe('approved');
    expect(inverseJobTypeToStatus('review')).toBe('developed');
    expect(inverseJobTypeToStatus('test')).toBe('testing');
    expect(inverseJobTypeToStatus('fix')).toBe('reopen');
    expect(inverseJobTypeToStatus('release')).toBe('released');
  });

  it('returns null for non-pipeline jobTypes (pm, custom)', () => {
    expect(inverseJobTypeToStatus('pm')).toBeNull();
    expect(inverseJobTypeToStatus('custom')).toBeNull();
  });
});

describe('createProjectSkillResolver', () => {
  it('returns the registered skill name for a status', async () => {
    queue.push([
      { stage: 'approved', name: 'custom-coder' },
      { stage: 'open', name: 'forge-triage' },
    ]);
    const resolver = createProjectSkillResolver(PROJECT_ID);
    const out = await resolver.resolve('approved');
    expect(out).toEqual({ type: 'code', toggle: 'autoCode', skillName: 'custom-coder' });
  });

  it('returns null when no registration exists for the stage', async () => {
    queue.push([{ stage: 'open', name: 'forge-triage' }]);
    const resolver = createProjectSkillResolver(PROJECT_ID);
    expect(await resolver.resolve('approved')).toBeNull();
  });

  it('returns null for human-gated statuses without hitting the DB', async () => {
    const resolver = createProjectSkillResolver(PROJECT_ID);
    expect(await resolver.resolve('waiting')).toBeNull();
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('memoizes the DB query across repeated resolve() calls', async () => {
    queue.push([
      { stage: 'open', name: 'forge-triage' },
      { stage: 'approved', name: 'forge-code' },
    ]);
    const resolver = createProjectSkillResolver(PROJECT_ID);
    const first = await resolver.resolve('open');
    const second = await resolver.resolve('approved');
    expect(first?.skillName).toBe('forge-triage');
    expect(second?.skillName).toBe('forge-code');
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });
});

describe('resolveSkillForStatus (single-shot wrapper)', () => {
  it('reads from the registration table for the given project', async () => {
    queue.push([{ stage: 'clarified', name: 'planner-skill' }]);
    const out = await resolveSkillForStatus('clarified', PROJECT_ID);
    expect(out).toEqual({ type: 'plan', toggle: 'autoPlan', skillName: 'planner-skill' });
  });

  it('returns null when no registration', async () => {
    queue.push([]);
    expect(await resolveSkillForStatus('approved', PROJECT_ID)).toBeNull();
  });
});

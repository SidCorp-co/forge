import { beforeEach, describe, expect, it, vi } from 'vitest';

const readProjectDocument = vi.fn();
vi.mock('../project-config/service.js', () => ({
  readProjectDocument: (...args: unknown[]) => readProjectDocument(...args),
}));

const { guardFault } = await import('./transition-guards.js');

type Verdict = { verdict: string; identity: string | null; at?: string };

function criterionRow(n: number, v: Verdict | null) {
  return {
    id: `c${n}`,
    n,
    statement: `criterion ${n}`,
    position: n,
    requirement_criterion_id: null,
    v_id: v ? `v${n}` : null,
    verdict: v?.verdict ?? null,
    reason: null,
    identity_kind: v?.identity ?? null,
    commit_sha: v?.identity === 'commit' ? 'a'.repeat(40) : null,
    runtime_ref: null,
    design_workflow_id: v?.identity === 'design' ? 'wf-1' : null,
    design_flow: v?.identity === 'design' ? 'issue-lifecycle' : null,
    design_revision: v?.identity === 'design' ? 2 : null,
    contract_ref: null,
    contract_version: null,
    storefront_workflow_id: null,
    storefront_draft_version: null,
    storefront_environment: null,
    corroboration: null,
    corroboration_note: null,
    evidence: [],
    author_agency: 'agent',
    backfilled: false,
    v_created_at: v?.at ?? '2026-10-04T10:00:00.000Z',
  };
}

function executor(criteria: ReturnType<typeof criterionRow>[], reopenedAt: string | null = null) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce(criteria)
    .mockResolvedValueOnce(reopenedAt ? [{ entity_id: 'i-1', at: reopenedAt }] : []);
  return { execute, select: vi.fn() };
}

const close = (exec: ReturnType<typeof executor>, from = 'in_progress') =>
  guardFault({
    issue: { id: 'i-1', projectId: 'p-1' },
    from: from as 'in_progress',
    to: 'closed',
    agency: 'human',
    executor: exec as never,
  });

beforeEach(() => {
  readProjectDocument.mockReset();
  readProjectDocument.mockResolvedValue(null);
});

describe('in_progress → closed asks the awaiting_release verdict rule of every issue (ISS-96)', () => {
  it('refuses a never-reopened issue with no criteria as NO_WORK_EVIDENCE', async () => {
    const fault = await close(executor([]));
    expect(fault?.code).toBe('NO_WORK_EVIDENCE');
    expect(fault?.detail).toContain('`closed` says every criterion holds a passing verdict');
  });

  it('refuses a never-reopened issue whose criterion holds no passing verdict, naming each', async () => {
    const fault = await close(
      executor([
        criterionRow(1, { verdict: 'pass', identity: 'commit' }),
        criterionRow(2, null),
        criterionRow(3, { verdict: 'skipped', identity: null }),
      ]),
    );
    expect(fault?.code).toBe('NO_WORK_EVIDENCE');
    expect(fault?.details).toMatchObject({
      unpassed: [
        { criterion: 2, verdict: null },
        { criterion: 3, verdict: 'skipped' },
      ],
    });
  });

  it('takes a never-reopened issue whose every criterion passed at a whole commit', async () => {
    expect(
      await close(executor([criterionRow(1, { verdict: 'pass', identity: 'commit' })])),
    ).toBeNull();
  });

  it('takes a design verdict on any issue, as awaiting_release does (ISS-91)', async () => {
    expect(
      await close(executor([criterionRow(1, { verdict: 'pass', identity: 'design' })])),
    ).toBeNull();
  });

  it('still refuses the passing verdicts from before a reopen', async () => {
    const fault = await close(
      executor(
        [criterionRow(1, { verdict: 'pass', identity: 'commit', at: '2026-10-04T09:00:00.000Z' })],
        '2026-10-04T09:30:00.000Z',
      ),
    );
    expect(fault?.code).toBe('VERDICT_PREDATES_REOPEN');
  });

  it('asks nothing of a close from awaiting_release, whose verdicts were asked on the way in', async () => {
    const exec = executor([]);
    expect(await close(exec, 'awaiting_release')).toBeNull();
    expect(exec.execute).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  agreeRefusals,
  changedSincePlan,
  linkIssueRefusal,
  openRevisionRefusal,
  planCriteria,
  reasonRefusal,
  scenarioParses,
  signoffRefusal,
  staleBaseRefusal,
  stateRefusal,
} from './rules.js';

const PROJECT = 'p-1';
const codeOf = (r: { code: string } | null | undefined) => r?.code ?? null;

describe('signoffRefusal (REQUIREMENT_SIGNOFF_FORBIDDEN)', () => {
  it('lets a person of the project sign off', () => {
    expect(
      signoffRefusal({ userId: 'u', agency: 'human', role: 'member' }, PROJECT, 'x'),
    ).toBeNull();
  });
  it('refuses an agent even with admin on the project', () => {
    expect(
      codeOf(signoffRefusal({ userId: 'm', agency: 'agent', role: 'admin' }, PROJECT, 'x')),
    ).toBe('REQUIREMENT_SIGNOFF_FORBIDDEN');
  });
  it('refuses a person who is only a viewer, or outside the project', () => {
    for (const role of ['viewer', null] as const) {
      expect(codeOf(signoffRefusal({ userId: 'u', agency: 'human', role }, PROJECT, 'x'))).toBe(
        'REQUIREMENT_SIGNOFF_FORBIDDEN',
      );
    }
  });
});

describe('revision moves', () => {
  it('a revision carries its reason (REVISION_REASON_REQUIRED)', () => {
    expect(codeOf(reasonRefusal('  '))).toBe('REVISION_REASON_REQUIRED');
    expect(reasonRefusal('scope widened')).toBeNull();
  });
  it('one open revision at a time (REQUIREMENT_REVISION_OPEN)', () => {
    expect(codeOf(openRevisionRefusal({ revision: 3, state: 'proposed' }))).toBe(
      'REQUIREMENT_REVISION_OPEN',
    );
    expect(openRevisionRefusal(null)).toBeNull();
  });
  it('a base that is no longer the head is stale (REQUIREMENT_REVISION_STALE)', () => {
    expect(codeOf(staleBaseRefusal(2, 3))).toBe('REQUIREMENT_REVISION_STALE');
    expect(staleBaseRefusal(3, 3)).toBeNull();
    expect(staleBaseRefusal(null, null)).toBeNull();
  });
  it('only a draft is proposed and only a proposed revision is accepted', () => {
    expect(codeOf(stateRefusal(2, 'proposed', 'draft'))).toBe('REQUIREMENT_REVISION_NOT_DRAFT');
    expect(codeOf(stateRefusal(2, 'draft', 'proposed'))).toBe('REQUIREMENT_REVISION_NOT_PROPOSED');
    expect(codeOf(stateRefusal(2, 'current', 'proposed'))).toBe(
      'REQUIREMENT_REVISION_NOT_PROPOSED',
    );
    expect(stateRefusal(2, 'proposed', 'proposed')).toBeNull();
  });
});

describe('agreeRefusals', () => {
  const approved = {
    workflowId: 'w1',
    flow: 'discharge',
    designStatus: 'approved',
    approvedRevision: 3,
  };
  const base = {
    status: 'draft' as const,
    named: 2,
    head: 2,
    headState: 'current' as const,
    designs: [approved],
    rebaseline: false,
  };

  it('agrees a current head whose every design is approved', () => {
    expect(agreeRefusals(base)).toEqual([]);
  });
  it('refuses a head that is not current (REQUIREMENT_REVISION_NOT_CURRENT)', () => {
    expect(agreeRefusals({ ...base, head: null, headState: null }).map((r) => r.code)).toEqual([
      'REQUIREMENT_REVISION_NOT_CURRENT',
    ]);
    expect(agreeRefusals({ ...base, headState: 'proposed' }).map((r) => r.code)).toEqual([
      'REQUIREMENT_REVISION_NOT_CURRENT',
    ]);
  });
  it('refuses naming a revision that is not the head (REQUIREMENT_REVISION_STALE)', () => {
    expect(agreeRefusals({ ...base, named: 1 }).map((r) => r.code)).toEqual([
      'REQUIREMENT_REVISION_STALE',
    ]);
  });
  it('refuses while a linked design is unapproved, naming each one (REQUIREMENT_DESIGN_UNAPPROVED)', () => {
    const refusals = agreeRefusals({
      ...base,
      designs: [
        approved,
        { workflowId: 'w2', flow: 'booking', designStatus: 'proposed', approvedRevision: 1 },
        { workflowId: 'w3', flow: 'reminder', designStatus: 'draft', approvedRevision: null },
      ],
    });
    expect(refusals.map((r) => r.code)).toEqual(['REQUIREMENT_DESIGN_UNAPPROVED']);
    expect(refusals[0]?.detail).toContain('"reminder"');
    expect(refusals[0]?.detail).not.toContain('"booking"');
    expect(refusals[0]?.detail).not.toContain('"discharge"');
  });
  it('pins the approved revision while a newer one is only proposed', () => {
    const refusals = agreeRefusals({
      ...base,
      status: 'agreed',
      rebaseline: true,
      designs: [
        {
          workflowId: 'w1',
          flow: 'discharge-post-care',
          designStatus: 'proposed',
          approvedRevision: 4,
        },
      ],
    });
    expect(refusals).toEqual([]);
  });
  it('refuses agreeing twice, but a re-baseline on accept passes the same guards', () => {
    expect(agreeRefusals({ ...base, status: 'agreed' }).map((r) => r.code)).toEqual([
      'REQUIREMENT_ALREADY_AGREED',
    ]);
    expect(agreeRefusals({ ...base, status: 'accepted', rebaseline: true })).toEqual([]);
  });
});

describe('linkIssueRefusal (REQUIREMENT_NOT_AGREED)', () => {
  it('links only to an agreed or accepted requirement', () => {
    expect(codeOf(linkIssueRefusal('draft'))).toBe('REQUIREMENT_NOT_AGREED');
    expect(codeOf(linkIssueRefusal('dropped'))).toBe('REQUIREMENT_NOT_AGREED');
    expect(linkIssueRefusal('agreed')).toBeNull();
    expect(linkIssueRefusal('accepted')).toBeNull();
  });
});

describe('planCriteria: stable BC codes across revisions', () => {
  const live = [
    { id: 'a', code: 'BC-1', body: 'Reminder sent 3 days before', form: 'statement' as const },
    { id: 'b', code: 'BC-2', body: 'Patient can opt out', form: 'statement' as const },
  ];

  it('numbers the criteria of revision 1 from BC-1', () => {
    const r = planCriteria([{ body: 'x' }, { body: 'y' }], [], 0);
    expect(r.ok && r.plan.insert.map((c) => c.code)).toEqual(['BC-1', 'BC-2']);
  });
  it('keeps an unchanged code, re-words a changed one under the same code, retires an omitted one', () => {
    const r = planCriteria(
      [
        { code: 'BC-1', body: 'Reminder sent 3 days before' },
        { body: 'Reminder names the clinic' },
      ],
      live,
      2,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.keep).toEqual(['a']);
    expect(r.plan.retire).toEqual(['b']);
    expect(r.plan.insert).toEqual([
      { code: 'BC-3', body: 'Reminder names the clinic', form: 'statement' },
    ]);
    const reworded = planCriteria([{ code: 'BC-2', body: 'Patient can opt out by SMS' }], live, 2);
    expect(reworded.ok && reworded.plan.retire.sort()).toEqual(['a', 'b']);
    expect(reworded.ok && reworded.plan.insert.map((c) => c.code)).toEqual(['BC-2']);
  });
  it('never reuses a retired number for a new criterion', () => {
    const r = planCriteria([{ body: 'new' }], [], 7);
    expect(r.ok && r.plan.insert[0]?.code).toBe('BC-8');
  });
  it('refuses an unknown or duplicated code', () => {
    const unknown = planCriteria([{ code: 'BC-9', body: 'x' }], live, 2);
    expect(!unknown.ok && unknown.refusals.map((r) => r.code)).toEqual(['CRITERION_CODE_UNKNOWN']);
    const dup = planCriteria(
      [
        { code: 'BC-1', body: 'x' },
        { code: 'BC-1', body: 'y' },
      ],
      live,
      2,
    );
    expect(!dup.ok && dup.refusals.map((r) => r.code)).toEqual(['CRITERION_CODE_DUPLICATE']);
  });
  it('refuses a scenario that does not read Given / When / Then (CRITERION_SCENARIO_UNPARSEABLE)', () => {
    const bad = planCriteria([{ body: 'the patient gets a reminder', form: 'scenario' }], [], 0);
    expect(!bad.ok && bad.refusals.map((r) => r.code)).toEqual(['CRITERION_SCENARIO_UNPARSEABLE']);
    expect(scenarioParses('Given a booked visit\nWhen 3 days remain\nThen an SMS is sent')).toBe(
      true,
    );
    expect(scenarioParses('When 3 days remain\nGiven a booked visit\nThen an SMS is sent')).toBe(
      false,
    );
  });
});

describe('changedSincePlan (REQUIREMENT_CHANGED_SINCE_PLAN)', () => {
  it('flags a plan written against another revision than the current one', () => {
    expect(changedSincePlan({ plan: 'p', plannedRevision: 3, currentRevision: 4 })).toBe(true);
    expect(changedSincePlan({ plan: 'p', plannedRevision: null, currentRevision: 4 })).toBe(true);
  });
  it('does not flag a plan at the current revision, or an issue with no plan', () => {
    expect(changedSincePlan({ plan: 'p', plannedRevision: 4, currentRevision: 4 })).toBe(false);
    expect(changedSincePlan({ plan: null, plannedRevision: null, currentRevision: 4 })).toBe(false);
  });
});

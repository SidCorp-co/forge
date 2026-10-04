import type { FeedbackTriage } from '@forge/contracts/feedback';
import { describe, expect, it } from 'vitest';
import type { ActorFacts } from '../lib/person-act.js';
import {
  attentionOf,
  clarificationRefusal,
  decideActRefusal,
  declineRefusal,
  duplicateRefusal,
  type PhaseFacts,
  phaseOf,
  redactActRefusal,
  redactedRefusal,
  reopenRefusal,
  routeFitRefusal,
  routeShapeRefusal,
  targetCountRefusal,
  triagePhaseRefusal,
  verifyActRefusal,
  verifyRefusal,
  waitingFor,
  waitingOf,
  waitingOnOf,
} from './rules.js';

const triaged = (over: Partial<PhaseFacts>): PhaseFacts => ({
  status: 'triaged',
  route: 'issue',
  routedIssueStatus: 'in_progress',
  suggestion: null,
  routedRequirementStatus: null,
  routedRequirementDelivered: false,
  rootPhase: null,
  ...over,
});

const person: ActorFacts = { userId: 'u1', agency: 'human', role: 'member' };
const agent: ActorFacts = { userId: 'a1', agency: 'agent', role: 'member' };

describe('feedback-lifecycle: the phase is read, never stored (Q1)', () => {
  it('reads planned while the routed issue is open, resolved once it is closed, triaged when it was dropped', () => {
    expect(phaseOf(triaged({}))).toBe('planned');
    expect(phaseOf(triaged({ routedIssueStatus: 'closed' }))).toBe('resolved');
    expect(phaseOf(triaged({ routedIssueStatus: 'dropped' }))).toBe('triaged');
  });

  it('reads a revision resolved only when accepted, live and delivered', () => {
    const s = { status: 'accepted' as const, revisionLive: true, delivered: false };
    expect(phaseOf(triaged({ route: 'revision', suggestion: s }))).toBe('planned');
    expect(phaseOf(triaged({ route: 'revision', suggestion: { ...s, delivered: true } }))).toBe(
      'resolved',
    );
    expect(phaseOf(triaged({ route: 'revision', suggestion: { ...s, status: 'rejected' } }))).toBe(
      'triaged',
    );
  });

  it('reads a new requirement planned while it is only agreed, resolved once it is delivered (feedback-lifecycle planned → resolved)', () => {
    const routed = (over: Partial<PhaseFacts>) =>
      triaged({ route: 'new_requirement', routedIssueStatus: null, ...over });
    expect(phaseOf(routed({ routedRequirementStatus: 'draft' }))).toBe('planned');
    expect(phaseOf(routed({ routedRequirementStatus: 'agreed' }))).toBe('planned');
    expect(
      phaseOf(routed({ routedRequirementStatus: 'agreed', routedRequirementDelivered: true })),
    ).toBe('resolved');
    expect(
      phaseOf(routed({ routedRequirementStatus: 'accepted', routedRequirementDelivered: true })),
    ).toBe('resolved');
    expect(phaseOf(routed({ routedRequirementStatus: 'dropped' }))).toBe('triaged');
  });

  it('reads a duplicate by its root, and an answer as resolved', () => {
    expect(phaseOf(triaged({ route: 'duplicate', rootPhase: 'verified' }))).toBe('resolved');
    expect(phaseOf(triaged({ route: 'duplicate', rootPhase: 'new' }))).toBe('planned');
    expect(phaseOf(triaged({ route: 'answer' }))).toBe('resolved');
  });

  it('never reads verified on its own: a closed issue makes it resolved, and only the stored status says verified', () => {
    expect(phaseOf(triaged({ routedIssueStatus: 'closed' }))).not.toBe('verified');
    expect(phaseOf({ ...triaged({}), status: 'verified' })).toBe('verified');
  });

  it('groups a resolved item under the reporter, everyone else sees someone else’s turn', () => {
    expect(attentionOf('resolved', true)).toBe('you');
    expect(attentionOf('resolved', false)).toBe('others');
    expect(attentionOf('planned', false)).toBe('moving');
  });
});

describe('feedback-lifecycle guards', () => {
  it('start -> new: exactly one target (FEEDBACK_TARGET_NOT_ONE)', () => {
    expect(targetCountRefusal({ issue: 'ISS-1' }, undefined)).toBeNull();
    expect(targetCountRefusal({ screen: 'Nurse dashboard' }, undefined)).toBeNull();
    expect(targetCountRefusal({}, undefined)?.code).toBe('FEEDBACK_TARGET_NOT_ONE');
    expect(targetCountRefusal({ issue: 'ISS-1', requirement: 'REQ-1' }, undefined)?.code).toBe(
      'FEEDBACK_TARGET_NOT_ONE',
    );
    expect(targetCountRefusal({ screen: 'x' }, 'y')?.code).toBe('FEEDBACK_TARGET_NOT_ONE');
  });

  it('new -> triaged: a planned or resolved item is FEEDBACK_STATUS_INVALID', () => {
    expect(triagePhaseRefusal('new')).toBeNull();
    expect(triagePhaseRefusal('reopened')).toBeNull();
    expect(triagePhaseRefusal('planned')?.code).toBe('FEEDBACK_STATUS_INVALID');
  });

  it('new -> triaged: a route names its carrier (FEEDBACK_ROUTE_INCOMPLETE, FEEDBACK_ANSWER_MISSING)', () => {
    const t = (over: Partial<FeedbackTriage>) => ({ route: 'issue', ...over }) as FeedbackTriage;
    expect(routeShapeRefusal(t({ issue: 'ISS-3' }))).toBeNull();
    expect(routeShapeRefusal(t({ createIssue: {} }))).toBeNull();
    expect(routeShapeRefusal(t({}))?.code).toBe('FEEDBACK_ROUTE_INCOMPLETE');
    expect(routeShapeRefusal(t({ route: 'answer', answer: ' ' }))?.code).toBe(
      'FEEDBACK_ANSWER_MISSING',
    );
  });

  it('new -> triaged: a route that does not fit is FEEDBACK_ROUTE_TARGET_MISMATCH', () => {
    const facts = {
      kind: 'bug' as const,
      targetType: 'requirement' as const,
      targetRequirementId: 'r1',
      suggestion: null,
      routedRequirement: null,
    };
    expect(routeFitRefusal({ route: 'issue', issue: 'ISS-1' }, facts)).toBeNull();
    expect(
      routeFitRefusal({ route: 'answer', answer: 'a' }, { ...facts, kind: 'contract_change' })
        ?.code,
    ).toBe('FEEDBACK_ROUTE_TARGET_MISMATCH');
    expect(
      routeFitRefusal(
        { route: 'revision', suggestion: '00000000-0000-4000-8000-000000000000' },
        { ...facts, suggestion: { kind: 'revision_diff', requirementId: 'r2' } },
      )?.code,
    ).toBe('FEEDBACK_ROUTE_TARGET_MISMATCH');
    expect(
      routeFitRefusal(
        { route: 'new_requirement', requirement: 'REQ-2' },
        { ...facts, routedRequirement: { key: 'REQ-2', status: 'agreed' } },
      )?.code,
    ).toBe('FEEDBACK_ROUTE_TARGET_MISMATCH');
  });

  it('new -> triaged (duplicate_of): a root that is a duplicate is FEEDBACK_DUPLICATE_CHAIN, itself FEEDBACK_DUPLICATE_SELF', () => {
    const root = { id: 'f2', key: 'FB-2', duplicateOfKey: null };
    expect(duplicateRefusal('f1', root, [])).toBeNull();
    expect(duplicateRefusal('f1', { ...root, duplicateOfKey: 'FB-1' }, [])?.code).toBe(
      'FEEDBACK_DUPLICATE_CHAIN',
    );
    expect(duplicateRefusal('f1', root, ['FB-9'])?.code).toBe('FEEDBACK_DUPLICATE_CHAIN');
    expect(duplicateRefusal('f2', root, [])?.code).toBe('FEEDBACK_DUPLICATE_SELF');
  });

  it('-> declined: carries a reason (FEEDBACK_DECLINE_REASON_REQUIRED), never from verified', () => {
    expect(declineRefusal('new', 'out of scope')).toBeNull();
    expect(declineRefusal('triaged', '')?.code).toBe('FEEDBACK_DECLINE_REASON_REQUIRED');
    expect(declineRefusal('verified', 'x')?.code).toBe('FEEDBACK_STATUS_INVALID');
  });

  it('resolved -> verified: only after resolved (FEEDBACK_NOT_RESOLVED)', () => {
    expect(verifyRefusal('resolved')).toBeNull();
    expect(verifyRefusal('planned')?.code).toBe('FEEDBACK_NOT_RESOLVED');
  });

  it('resolved -> reopened: carries a reason (FEEDBACK_REOPEN_REASON_REQUIRED)', () => {
    expect(reopenRefusal('resolved', 'still 2am')).toBeNull();
    expect(reopenRefusal('resolved', ' ')?.code).toBe('FEEDBACK_REOPEN_REASON_REQUIRED');
    expect(reopenRefusal('planned', 'x')?.code).toBe('FEEDBACK_NOT_RESOLVED');
  });

  it('new: at most one open clarification, before routing (Q5)', () => {
    expect(clarificationRefusal('new', null)).toBeNull();
    expect(clarificationRefusal('new', 'q1')?.code).toBe('FEEDBACK_CLARIFICATION_ALREADY_OPEN');
    expect(clarificationRefusal('planned', null)?.code).toBe('FEEDBACK_CLARIFICATION_CLOSED');
  });

  it('UC15: a second deletion is FEEDBACK_ALREADY_REDACTED', () => {
    expect(redactedRefusal(null)).toBeNull();
    expect(redactedRefusal(new Date())?.code).toBe('FEEDBACK_ALREADY_REDACTED');
  });
});

describe('who may act', () => {
  it('routing and verifying take feedback.approve, an agent holding it included (ADR 0007)', () => {
    expect(decideActRefusal({ ...agent, role: 'admin' }, 'p', 'routing')).toBeNull();
    expect(verifyActRefusal({ ...agent, role: 'admin' }, 'p', 'verifying')).toBeNull();
    for (const role of ['member', 'viewer', null] as const) {
      expect(decideActRefusal({ ...person, role }, 'p', 'routing')).toMatchObject({
        code: 'APPROVE_PERMISSION_REQUIRED',
        permission: 'feedback.approve',
      });
    }
    expect(verifyActRefusal(agent, 'p', 'verifying')?.code).toBe('APPROVE_PERMISSION_REQUIRED');
  });

  it('only a project admin person deletes reporter data (FEEDBACK_REDACT_FORBIDDEN)', () => {
    expect(redactActRefusal({ ...person, role: 'admin' })).toBeNull();
    expect(redactActRefusal(person)?.code).toBe('FEEDBACK_REDACT_FORBIDDEN');
    expect(redactActRefusal({ ...agent, role: 'admin' })?.code).toBe('FEEDBACK_REDACT_FORBIDDEN');
  });
});

describe('whose turn a feedback row is', () => {
  it('names the carrier a planned item waits on, as a cell and as a sentence', () => {
    expect(waitingOf('planned', 'issue', 'ISS-12', 'Bao')).toEqual({
      kind: 'issue',
      who: 'ISS-12',
      act: 'ship',
    });
    expect(waitingOnOf('planned', 'issue', 'ISS-12', 'Bao')).toBe('ISS-12 to ship');
  });

  it('puts a resolved item on its reporter, and on the viewer when they are that reporter', () => {
    const w = waitingOf('resolved', 'issue', 'ISS-12', 'Bao');
    expect(w).toEqual({ kind: 'person', who: 'Bao', act: 'verify the fix' });
    expect(waitingFor(w, attentionOf('resolved', true))).toEqual({
      kind: 'you',
      who: 'You',
      act: 'verify the fix',
    });
    expect(waitingFor(w, attentionOf('resolved', false))).toEqual(w);
  });

  it('owes nothing once verified or declined, and says so without an act', () => {
    expect(waitingOf('verified', 'issue', 'ISS-12', 'Bao')).toEqual({
      kind: 'none',
      who: 'Nothing',
      act: '',
    });
    expect(waitingOnOf('declined', null, null, 'Bao')).toBe('Nothing');
  });

  it('names a root with no key without a stray space', () => {
    expect(waitingOnOf('planned', 'duplicate', null, 'Bao')).toBe('Its root to be resolved');
  });
});

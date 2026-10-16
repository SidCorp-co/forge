// FB-53's witness drew a resolved item with its triage form above "Confirm the fix", from a fixture
// that held `triage` and `verify` both. The read never answers that: triage is for an item still to
// route, the loop close's acts for one that reads resolved, and no phase holds both.

import { FEEDBACK_PHASES, type FeedbackPhase } from '@forge/contracts/feedback';
import { describe, expect, it } from 'vitest';
import { canOf, type Row } from './read.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const VIEWER = '00000000-0000-4000-8000-0000000000aa';
const row = {
  reportedBy: '00000000-0000-4000-8000-0000000000bb',
  redactedAt: null,
  contractVersion: null,
} as Row;
const roles = ['admin', 'member', 'viewer'] as const;

const can = (phase: FeedbackPhase, role: (typeof roles)[number], open = false) =>
  canOf({
    facts: { projectId, role, grants: [] },
    row,
    phase,
    userId: VIEWER,
    canSeeNotes: false,
    clarificationOpen: open,
  });

describe('a feedback item offers triage or the loop close, never both', () => {
  it.each(FEEDBACK_PHASES.flatMap((phase) => roles.map((role) => [phase, role] as const)))(
    'reads %s for a %s: triage and verify do not hold together',
    (phase, role) => {
      const c = can(phase, role);
      expect(c.triage && (c.verify || c.reopen || c.askVerify), `${phase} as ${role}`).toBe(false);
    },
  );

  it('offers a triager triage on a new item and the confirm block on a resolved one', () => {
    expect(can('new', 'admin')).toMatchObject({ triage: true, verify: false });
    expect(can('resolved', 'admin')).toMatchObject({
      triage: false,
      verify: true,
      reopen: true,
      askVerify: true,
    });
  });
});

// the clarification form is offered exactly where `POST …/clarification` takes a send
describe('a clarification is offered where the route takes one', () => {
  it('offers a writer the clarification on an untriaged item with none open', () => {
    expect(can('new', 'member').clarify).toBe(true);
    expect(can('reopened', 'member').clarify).toBe(true);
  });

  it('refuses it once one is open, at the one-open boundary', () => {
    expect(can('new', 'member', true).clarify).toBe(false);
  });

  it('refuses it once the item is routed, and to a reader who may not write', () => {
    for (const phase of FEEDBACK_PHASES.filter((p) => p !== 'new' && p !== 'reopened')) {
      expect(can(phase, 'member').clarify, phase).toBe(false);
    }
    expect(can('new', 'viewer').clarify).toBe(false);
  });
});

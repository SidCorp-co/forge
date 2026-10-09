// The intake draft written into a requirement's open draft (REQ-34 BC-4, BC-13): only a gap is
// filled, a word the author wrote is never replaced, and every fill that lands is stated as an
// assumption naming its source.

import { describe, expect, it } from 'vitest';
import { type DraftGapFill, draftGapsOf, withGapsFilled } from './draft-gaps.js';

const fills: DraftGapFill[] = [
  { field: 'summary', value: 'Referrals match patients by clinic code.', source: 'REQ-1' },
  { field: 'goal', value: 'No referral reaches the wrong patient.', source: 'FB-3' },
  { field: 'persona', value: 'Referral clerk', source: 'workflow:referral' },
  { field: 'persona', value: 'Clinic', source: 'workflow:referral' },
  { field: 'in_scope', value: 'Matching by clinic code', source: 'REQ-9' },
  { field: 'criterion', value: 'A referral is matched by its clinic code.', source: 'REQ-1' },
];

describe('the intake draft written into an open draft', () => {
  it('fills every gap of a one-sentence requirement and states each fill as an assumption with its source', () => {
    const draft = { tldr: null, spec: {} };
    const out = withGapsFilled(draft, draftGapsOf(draft, 0), fills);
    expect(out.tldr).toBe('Referrals match patients by clinic code.');
    expect(out.spec.goal).toBe('No referral reaches the wrong patient.');
    expect(out.spec.personas).toEqual(['Referral clerk', 'Clinic']);
    expect(out.spec.scopeIn).toEqual(['Matching by clinic code']);
    expect(out.criteria).toEqual(['A referral is matched by its clinic code.']);
    expect(out.spec.assumptions?.map((a) => [a.text, a.source])).toEqual([
      ['Summary: Referrals match patients by clinic code.', 'REQ-1'],
      ['Goal: No referral reaches the wrong patient.', 'FB-3'],
      ['Persona: Referral clerk', 'workflow:referral'],
      ['Persona: Clinic', 'workflow:referral'],
      ['In scope: Matching by clinic code', 'REQ-9'],
      ['Criterion: A referral is matched by its clinic code.', 'REQ-1'],
    ]);
    expect(out.spec.assumptions?.every((a) => a.owner === 'BA assistant')).toBe(true);
    expect(out.fields).toEqual(['summary', 'goal', 'persona', 'in_scope', 'criterion']);
  });

  it('never replaces what the author wrote, and states nothing it did not fill', () => {
    const draft = {
      tldr: 'The author’s own summary.',
      spec: {
        goal: 'The author’s goal.',
        personas: ['Nurse'],
        assumptions: [{ text: 'The author assumes this.', owner: 'Author', confirmBy: 'Pilot' }],
      },
    };
    const out = withGapsFilled(draft, draftGapsOf(draft, 2), fills);
    expect(out.tldr).toBe('The author’s own summary.');
    expect(out.spec.goal).toBe('The author’s goal.');
    expect(out.spec.personas).toEqual(['Nurse']);
    expect(out.criteria).toEqual([]);
    expect(out.spec.assumptions?.map((a) => a.text)).toEqual([
      'The author assumes this.',
      'In scope: Matching by clinic code',
    ]);
    expect(out.fields).toEqual(['in_scope']);
  });

  it('takes the first fill of a field that holds one value, and states only that one', () => {
    const draft = { tldr: null, spec: {} };
    const out = withGapsFilled(draft, draftGapsOf(draft, 1), [
      { field: 'summary', value: 'First.', source: 'REQ-1' },
      { field: 'summary', value: 'Second.', source: 'REQ-2' },
    ]);
    expect(out.tldr).toBe('First.');
    expect(out.spec.assumptions?.map((a) => a.text)).toEqual(['Summary: First.']);
  });
});

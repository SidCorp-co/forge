import { gateSays, resolveGate } from '@forge/contracts/gate-profiles';
import { describe, expect, it } from 'vitest';
import { advisedCriteriaWarningSentence, type HeldIssueRef } from './blocker-sentences.js';

// Agenfold, 2026-10-30: under gate release_criteria `advise` the warning read "A release will still
// be cut, without 5 issues the sweep is holding back … It is shipped anyway" — two claims that cannot
// both hold. Under advise the sweep carries every one of them (`release-sweep.ts`), so the sentence
// says they ship owing their criteria, and names the gate that lets them.

const held: HeldIssueRef[] = [
  { issueId: 'u1', displayId: 'AGF-12', criteria: [1, 3] },
  { issueId: 'u2', displayId: 'AGF-14', criteria: [2] },
];
const gate = resolveGate({ profile: 'yolo' }, 'release_criteria', 'enforce');

describe('advisedCriteriaWarningSentence: what advise says about issues owing criteria', () => {
  const readings = [
    null,
    { kind: 'undeclared', missing: 'a production URL', route: 'declare one' } as const,
  ];

  it.each(readings)('never says the issues are held back (reading %o)', (serving) => {
    const said = advisedCriteriaWarningSentence(held, serving as never, gateSays(gate));
    expect(said).not.toMatch(/holding back|held back|stays at the gate|without \d+ issue/i);
  });

  it('says they ship owing their criteria, each by key and number, and names the gate', () => {
    const said = advisedCriteriaWarningSentence(held, null, gateSays(gate));
    expect(said).toContain('2 issues ship in this release still owing');
    expect(said).toContain('`AGF-12` owes criteria 1, 3');
    expect(said).toContain('`AGF-14` owes criterion 2');
    expect(said).toContain(
      "Gate release_criteria is advise by this project's gate profile yolo (gates.profile)",
    );
  });
});

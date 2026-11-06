import { STEWARD_ACTS } from '@forge/contracts/steward';
import { describe, expect, it } from 'vitest';
import { actPrompt } from './prompts.js';

const all = STEWARD_ACTS.map((act) => [act, actPrompt(act)] as const);

// ISS-861 (owner, 2026-11-01): a steward act is told its goal and the doors it acts through, not a
// script with a question count. No door refuses a question by count either (ISS-904).
describe('a steward act is told a goal, not a script', () => {
  it.each(all)('%s carries no smallest-act rule and no question count', (_act, prompt) => {
    expect(prompt).toContain('Your goal is that the item moves again');
    expect(prompt).not.toContain('the smallest act');
    expect(prompt).not.toMatch(/at most \d+ questions/);
    expect(prompt).not.toContain('up to 3 candidates');
    expect(prompt).not.toContain('one is open at a time per reporter');
  });

  it('keeps the limits the steward may not cross', () => {
    const stuck = actPrompt('stuck_diagnosis');
    expect(stuck).toContain('Never dispatch a run');
    expect(stuck).toContain('drop, decline, merge or verify anything yourself');
    expect(actPrompt('triage_draft')).toContain('Never decline an item');
    expect(actPrompt('output_check')).toContain('You never move an issue back');
  });

  // ISS-1057 (owner direction, 2026-11-07): agents decide and execute on the record; an act the
  // steward does not take is asked of whoever takes it, the master included, never framed as a
  // person's by default
  it('asks whoever owns an act, not a person by default', () => {
    const stuck = actPrompt('stuck_diagnosis');
    expect(stuck).toContain('Forge addresses each ask to whoever takes the act');
    expect(stuck).toContain("the project's master where it holds it");
    expect(stuck).not.toContain("What is a person's, asked with steward_decide");
    expect(stuck).not.toContain('a person answers those');
    const triage = actPrompt('triage_draft');
    expect(triage).toContain('a decline takes feedback.approve, and is asked of whoever holds it');
    expect(triage).not.toContain("a decline is a person's decision");
  });
});

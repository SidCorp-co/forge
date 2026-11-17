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

  // ISS-1006 (owner 2026-11-05): every door that asks is taught the plain text, the ask door too
  it('teaches the plain text on every door that asks', () => {
    for (const act of ['intake_check', 'breakdown_check'] as const) {
      expect(actPrompt(act)).toContain('Every steward_ask carries `plain`');
    }
    expect(actPrompt('stuck_diagnosis')).toContain('Every steward_decide carries `plain`');
  });
});

// ISS-1267 (FB-697, agenfold L-88): the follow-through wrote verdicts before it read the issue's
// criteria, their design classes and judged-build, and each was refused for what that read showed
describe('the release follow-through reads before it judges', () => {
  const said = actPrompt('release_followthrough').replace(/\s+/g, ' ');

  it('reads the criteria, their class and judge, then judged-build, before the first verdict', () => {
    const first = said.indexOf('Read before your first verdict');
    expect(first).toBeGreaterThan(-1);
    expect(said.indexOf('GET /api/issues/<id>/criteria')).toBeGreaterThan(first);
    expect(said.indexOf('GET /api/issues/<id>/judged-build')).toBeGreaterThan(
      said.indexOf('GET /api/issues/<id>/criteria'),
    );
    expect(said.indexOf('POST /api/issues/<id>/verdicts')).toBeGreaterThan(
      said.indexOf('GET /api/issues/<id>/judged-build'),
    );
    expect(said).toContain('each with its `class`, the `judge` it routes to');
  });

  it('names what each read rules out: an empty record, a review criterion, a version as a runtime', () => {
    expect(said).toContain('An empty criteria record holds nothing to judge: record no verdict');
    expect(said).toContain('`VERDICT_JUDGED_BY_REVIEW`');
    expect(said).toContain('A version is never a runtime (`VERDICT_RUNTIME_NOT_FULL`)');
    expect(said).toContain('record its verdict once');
  });
});

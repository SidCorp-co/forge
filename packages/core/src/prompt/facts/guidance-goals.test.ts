// ISS-861 (owner, 2026-11-01): the prompts a run, a step and a chat are handed state goals and the
// kernel, never a ritual. Each cut ritual is pinned absent here, so its return goes red by name; the
// kernel each one sat beside is pinned present, so a cut that took the kernel with it goes red too.

import { describe, expect, it } from 'vitest';
import { getGuide } from '../../guides/index.js';
import { DRIVE_RULES_TEXT } from './drive-rules.js';
import { OPERATING_AFFORDANCES_TEXT, renderFact } from './registry.js';

const PIPELINE_RULES = renderFact('pipeline-rules') ?? '';
const STEP_HANDOFF = renderFact('handoff', { stage: 'code' }) ?? '';
const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('a step and a drive run are handed no output ritual', () => {
  it.each([
    ['pipeline rules', PIPELINE_RULES],
    ['drive rules', DRIVE_RULES_TEXT],
  ])('%s carry no zero-narration rule and no closing status line', (_who, text) => {
    expect(text).not.toContain('Zero narration');
    expect(text).not.toContain('No explanations between edits');
    expect(text).not.toContain('Never repeat file contents');
    expect(text).not.toContain('One-line status at the end');
    expect(text).not.toContain('## Output Rules');
    expect(text).toContain('Nobody reads this terminal');
  });

  it('a step is not told to reply DONE, and still learns the status move is what advances it', () => {
    expect(STEP_HANDOFF).not.toContain('DONE');
    expect(PIPELINE_RULES).not.toContain('The FINAL action of every step MUST be a status move');
    expect(PIPELINE_RULES).toContain('The status move is what advances the pipeline');
  });

  it('a step keeps no sessionContext merge and no churn entry', () => {
    expect(PIPELINE_RULES).not.toContain('## Session Context');
    expect(PIPELINE_RULES).not.toContain('Cap arrays at 20');
    expect(PIPELINE_RULES).not.toContain('churn');
    expect(PIPELINE_RULES).not.toContain('sessionCount');
  });

  it('keeps the kernel the rituals sat beside: the park fields, the shipped close and the verified mark', () => {
    for (const kernel of [
      'WAITING_KIND_REQUIRED',
      'TRANSITION_REASON_REQUIRED',
      'CLOSE_ONLY_BY_RELEASE',
      'CLOSE_REQUIRES_SHIPPED',
      'LANDING_REQUIRED',
      'ILLEGAL_TRANSITION',
    ]) {
      expect(PIPELINE_RULES).toContain(kernel);
    }
  });
});

describe('a drive run recalls by judgement and splits by judgement', () => {
  it('is not told to recall every time the work turns', () => {
    expect(DRIVE_RULES_TEXT).not.toContain('every time the work turns to a new area');
    expect(DRIVE_RULES_TEXT).toContain('before you design');
  });

  it('is not told every split stays in its session on one branch', () => {
    expect(DRIVE_RULES_TEXT).not.toContain('it stays inside this session');
    expect(DRIVE_RULES_TEXT).toContain('Splitting is your judgement');
  });

  it('may give a defect an issue of its own', () => {
    expect(DRIVE_RULES_TEXT).not.toContain('Do not file it as a new issue either');
    expect(DRIVE_RULES_TEXT).toContain('or an issue of its own');
  });
});

describe('the orientation affordances are judgement guidance, with the refusals core holds', () => {
  it('names no red-flag list and no "never file" absolute', () => {
    expect(OPERATING_AFFORDANCES_TEXT).not.toContain('red flag');
    expect(OPERATING_AFFORDANCES_TEXT).not.toContain('Forge red flags');
    expect(OPERATING_AFFORDANCES_TEXT).not.toContain('that is not one of the options');
    expect(OPERATING_AFFORDANCES_TEXT).not.toContain('never filed');
    expect(OPERATING_AFFORDANCES_TEXT).not.toContain('Pre-filling');
  });

  it('keeps every kernel refusal the table taught', () => {
    for (const kernel of [
      'CONFIG_WRITE_SHAPE',
      'CLOSE_ONLY_BY_RELEASE',
      'DESIGN_NOT_DELIVERED',
      'RELEASE_ALL_DESIGN_ONLY',
      'A stale revision is refused by name',
      'Only a `blocks` edge gates dispatch',
    ]) {
      expect(OPERATING_AFFORDANCES_TEXT).toContain(kernel);
    }
  });

  it('the issue guides route a residual to an owner, an issue of its own among them', () => {
    const issue = flat(getGuide('what-is-an-issue')?.body ?? '');
    expect(issue).not.toContain('Filing a NEW issue is not on that list');
    expect(issue).toContain('It is separate work');
    const setup = getGuide('agent-setup')?.body ?? '';
    expect(setup).not.toContain('### Red flags');
    expect(setup).not.toContain('plan-by-hand');
  });
});

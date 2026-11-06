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
      'CLOSE_CRITERION_UNPLACED',
      'CLOSE_REQUIRES_SHIPPED',
      'ILLEGAL_TRANSITION',
    ]) {
      expect(PIPELINE_RULES).toContain(kernel);
    }
  });

  // ISS-1017: whether work is done is the agent's call, so no refusal for missing evidence is taught
  it("teaches the mark as the agent's word, naming what it has, and no refusal core no longer makes", () => {
    for (const text of [PIPELINE_RULES, DRIVE_RULES_TEXT]) {
      expect(text).toContain('`liveReading`');
      expect(text).toContain('never a refusal');
      for (const gone of [
        'LANDING_REQUIRED',
        'NO_WORK_EVIDENCE',
        'LANDING_NOT_THIS_SHAPE',
        'TARGET_REQUIRED',
      ]) {
        expect(text).not.toContain(gone);
      }
      expect(text).not.toContain('CALLER-ASSERTED — nothing server-side checks git');
    }
  });
});

describe('a drive run recalls by judgement and builds its issue whole', () => {
  it('is not told to recall every time the work turns', () => {
    expect(DRIVE_RULES_TEXT).not.toContain('every time the work turns to a new area');
    expect(DRIVE_RULES_TEXT).toContain('before you design');
  });

  // ISS-1057 (owner direction, 2026-11-07): an issue is one verifiable outcome, built whole and never
  // split across releases; a part is an issue of its own only for priority, handoff or tracking
  it('builds its issue whole as one outcome and never splits it across releases', () => {
    const rules = flat(DRIVE_RULES_TEXT);
    expect(rules).not.toContain('it stays inside this session');
    expect(rules).not.toContain('Splitting is your judgement');
    expect(rules).not.toContain('Where a part genuinely ships separately');
    expect(rules).not.toContain('Work that turns out to be a different deliverable');
    expect(rules).toContain('**An issue is one verifiable outcome, built whole.**');
    expect(rules).toContain('one issue is never split across releases');
    expect(rules).toContain(
      'a part becomes an issue of its own only for priority, a handoff or independent tracking',
    );
    expect(rules).toContain('go on with the part that does not depend on it');
  });

  // ISS-1057: the fix does what bounds its impact or proves it; standalone cleanup is debt for Audit
  it('fixes what the fix needs, records a standalone defect as debt, and never cleans inside the fix', () => {
    const rules = flat(DRIVE_RULES_TEXT);
    expect(rules).not.toContain('Do not file it as a new issue either');
    expect(rules).not.toContain(
      'Where it is in reach, fixing it in this issue is usually cheapest',
    );
    expect(rules).toContain(
      'Where your fix needs it — to bound its impact or to prove itself — fix it',
    );
    expect(rules).toContain(
      'Where it stands alone, record it as debt for the Audit with its evidence (`projects/<projectId>/debts -X POST`)',
    );
    expect(rules).toContain(
      'recorded there it is discharged, mentioned only in a comment it is not',
    );
    expect(rules).toContain(
      'Cleanup that can stand alone is recorded as debt for the Audit, never done inside the fix',
    );
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
      'CLOSE_CRITERION_UNPLACED',
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

// ISS-984 (owner, 2026-11-05): masters filed their own findings straight into Delivery, features
// among them, because "fix it now or file it" read as "file a draft issue". ISS-1057 (2026-11-07):
// a standalone technical defect is debt for Audit, an issue of its own only for priority, handoff or
// tracking, and the fix carries only what it needs. The texts draw each place, with examples.
describe('the texts an agent reads give each finding its place', () => {
  const issue = flat(getGuide('what-is-an-issue')?.body ?? '');
  const affordances = flat(OPERATING_AFFORDANCES_TEXT);

  it('the orientation table routes a product finding to Feedback, a standalone defect to the debt ledger, and a needed one into the fix', () => {
    for (const row of [
      '| A product finding: it changes what a user sees or should expect (a feature you noticed)',
      'Feedback, `projects/<id>/feedback -X POST`',
      'a feature never starts as an issue an agent filed',
      '| A technical defect of your own that stands alone:',
      '(a missing index, an untyped route)',
      'debt for the Audit, `projects/<id>/debts -X POST` with its evidence',
      'only for priority, a handoff or independent tracking',
      'cleanup done inside the fix; a defect only mentioned in a comment',
      '| A defect your fix needs, to bound its impact or prove itself | fix it there, and say so under `Extra fixes:`',
    ]) {
      expect(affordances).toContain(row);
    }
    expect(affordances).not.toContain('`needs_info`, or an issue of its own |');
    expect(affordances).not.toContain('| A defect inside the issue you are working | fix it there');
    expect(affordances).not.toContain("| its module's technical backlog: an issue with its kind");
  });

  it('what-is-an-issue makes an issue one outcome and gives each finding its place, with an example', () => {
    for (const place of [
      'An issue is **one verifiable outcome**',
      'A separate issue is filed only for one of three reasons: **priority**',
      '### Where what you find goes',
      'does it change what a user sees or should expect?',
      '| **Product** |',
      'a filter the export screen lacks, which you would add: Feedback of kind `idea`, never an issue you file',
      '| **Inside your fix** | a defect your fix needs, to bound its own impact or to prove itself |',
      '| **Debt for Audit** |',
      'a list query with no index on its filter column',
      'Never done inside the fix',
      '| **An issue of its own** |',
      'declared under `Extra fixes:`',
      '**A feature never starts as an issue an agent filed.** Core does not refuse one',
    ]) {
      expect(issue).toContain(place);
    }
    expect(issue).not.toContain('### Two lanes for what you find');
    expect(issue).not.toContain(
      '| **Inside your issue** | a defect in what the issue you are working already touches',
    );
    expect(issue).not.toContain('usually cheapest to fix it');
  });

  it('what-is-an-issue says how a standalone defect is recorded and when a technical issue is filed', () => {
    expect(issue).toContain('#### Recording a standalone defect as debt');
    expect(issue).toContain('`POST /api/projects/:id/debts`');
    expect(issue).toContain(
      'A defect recorded there is discharged; one only mentioned in a comment is not.',
    );
    expect(issue).toContain('#### Filing a technical issue of its own');
    expect(issue).toContain('Only for priority, handoff or independent tracking');
    expect(issue).toContain('one of `bug`, `security`, `performance`, `debt` or `contract`');
    expect(issue).toContain('[{ "labelId": "<module name>", "isPrimary": true }]');
    expect(issue).toContain('`Found in: <the issue or run you were working> — <evidence');
    expect(issue).toContain('Nothing else is asked: no requirement, no Feedback.');
    expect(issue).not.toContain('#### Filing a technical item today');
  });

  it('a residual goes to the fix, the debt ledger or its place, never a bare draft', () => {
    expect(issue).not.toContain(
      'an issue of its own that passes the four gates, with someone who will pick it up',
    );
    expect(issue).toContain(
      '**Your fix needs it**, to bound its impact or to prove itself → fix it',
    );
    expect(issue).toContain('**It stands alone** → debt for the Audit');
    expect(issue).toContain('**It is separate work** → its place, above');
    expect(issue).toContain('Never a bare `draft` with no module, kind or evidence.');
  });

  it('the other issue guides point a finding to its place', () => {
    expect(flat(getGuide('writing-an-issue')?.body ?? '')).toContain(
      '**A technical backlog item is the first shape** — filed only for priority, handoff or independent tracking',
    );
    expect(flat(getGuide('writing-an-issue')?.body ?? '')).toContain('**Write one outcome.**');
    expect(flat(getGuide('pipeline-and-issue-lifecycle')?.body ?? '')).toContain(
      "An agent's own finding goes to its place first",
    );
    expect(flat(getGuide('issue-flow')?.body ?? '')).toContain('Separate work goes to its place');
    expect(flat(DRIVE_RULES_TEXT)).toContain(
      'a product finding (it changes what a user sees or should expect) to Feedback',
    );
  });
});

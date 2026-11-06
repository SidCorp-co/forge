import { describe, expect, it } from 'vitest';
import { ISSUE_FLOW_GUIDE } from './issue-flow-guide.js';

// read as prose, wherever a line wraps
const prose = ISSUE_FLOW_GUIDE.body.split(/\s+/).join(' ');

// ISS-861 (owner, 2026-11-01): the plan is optional, the approvals are gates a project turns on,
// and work is split by disjoint files and landed as a batch — never a per-issue ceremony.
describe('the issue-flow guide states goals, with the gates a project turns on', () => {
  it('makes the plan optional and keeps the criteria the release judges by', () => {
    expect(prose).not.toContain("Plan and criteria, in the issue's own fields");
    expect(prose).not.toContain('with `plan` and `acceptanceCriteria` together, before the code');
    expect(prose).toContain('A plan is optional');
    expect(prose).toContain('CRITERIA_TEXT_UNPARSEABLE');
  });

  it('drops the correction-before-every-unplanned-file rule', () => {
    expect(prose).not.toContain('A file it does not name is a `correction` record');
  });

  it('applies plan approval, pattern approval and the design record only where the gate is on', () => {
    expect(prose).toContain(
      'Plan approval, pattern approval and the design record are gates a project turns on or off',
    );
    expect(prose).toContain('Where gate `design_record` is on, record the design');
    for (const kernel of [
      'PLAN_APPROVAL_PENDING',
      'PATTERN_REVIEW_PENDING',
      'DESIGN_RECORD_MISSING',
      'MERGE_NOT_RECORDED',
      'CLOSE_CRITERION_UNPLACED',
    ]) {
      expect(prose).toContain(kernel);
    }
  });

  it('splits by disjoint files, lands a batch once, and proves without a per-criterion ritual heading', () => {
    expect(prose).toContain('split by disjoint files');
    expect(prose).toContain('A batch lands once, and its gate runs once over the batch');
    expect(prose).not.toContain('Prove it, one criterion at a time');
    expect(prose).toContain('ISSUE_SCOPE_HELD');
  });

  // ISS-1057: each defect seen has one place — the fix, the debt ledger, or its owner — and a part
  // is an issue of its own only for priority, a handoff or independent tracking
  it('gives each finding one place, and separate work an issue only for priority, handoff or tracking', () => {
    expect(prose).not.toContain('Never a new issue filed to carry it');
    expect(prose).not.toContain(
      'or an issue of its own where it is separate work someone will pick up',
    );
    expect(prose).not.toContain('A defect in reach and inside this issue');
    expect(prose).not.toContain('**More than one run** — split it');
    expect(prose).toContain(
      '**Your fix needs it**, to bound its impact or to prove itself: fix it here',
    );
    expect(prose).toContain(
      '**It stands alone**: record it as debt for the Audit, with its evidence',
    );
    expect(prose).toContain(
      'Recorded there it is discharged; mentioned only in a comment it is not.',
    );
    expect(prose).toContain('**Out of reach**: routed to whoever owns it');
    expect(prose).toContain('Separate work goes to its place');
    expect(prose).toContain('is Feedback, never an issue you file');
    expect(prose).toContain("issue of its own in its module's technical backlog");
    expect(prose).toContain(
      'A part becomes an issue of its own only for priority, a handoff or independent tracking',
    );
  });

  // ISS-1057: verification follows the blast radius, and the close is the criteria met in scope
  it('checks wide early by blast radius, and keeps the three marks apart', () => {
    expect(prose).toContain(
      'Where the change touches shared logic, billing, permissions or data, check wide early',
    );
    expect(prose).toContain('**An issue closes when its criteria are met in scope**');
    expect(prose).toContain('are marks on the release, never issue statuses');
    expect(prose).toContain('**The run holding the issue closes it:**');
    expect(prose).not.toContain("**Today the kernel still makes the close a release's act:**");
    expect(prose).not.toContain('CLOSE_ONLY_BY_RELEASE');
  });
});

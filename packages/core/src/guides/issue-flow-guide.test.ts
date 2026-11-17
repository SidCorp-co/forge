import { describe, expect, it } from 'vitest';
import { DIRECT_ORDER } from '../masters/pass-order.js';
import { DISPATCH_GUIDE } from './dispatch-guide.js';
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
    // ISS-1087: the step names each lane by the route that records it, product and technical
    expect(prose).toContain(
      'is Feedback (`POST /api/projects/:id/feedback`), never an issue you file',
    );
    expect(prose).toContain('`POST /api/projects/:id/debts`');
    expect(prose).toContain('A technical one is debt, as above, or');
    expect(prose).toContain("issue of its own in its module's technical backlog");
    expect(prose).toContain('`Found in:` this issue with the evidence');
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

// ISS-1256 r5: a working day of landings wrote no term or rule while "when work finishes, add terms"
// sat only in module cards no agent opened then; the step is taught where landing work is done.
describe('the landing teaches recording what the work named, at the mark', () => {
  const flat = (text: string) => text.split(/\s+/).join(' ');
  it('names the step, the mark answer it reads and the write, in the guide, the direct method and the nudge', () => {
    expect(prose).toContain(
      '5. Record what the work named, before you hand it on: the mark answers `moduleMap`',
    );
    expect(prose).toContain('(`PUT /api/projects/:id/knowledge/<slug>`)');
    expect(flat(DISPATCH_GUIDE.body)).toContain(
      "Record the terms and rules the work named under its module, as the mark's `moduleMap` says",
    );
    expect(DIRECT_ORDER).toContain(
      'Each mark answers `moduleMap`: write there the terms and rules',
    );
  });

  // ISS-1256 c9: on 2026-11-17 the step read "each term a person used" and "Met none, write none",
  // and four landings wrote none: no person names a thing inside a landing, and the builders who
  // met the names were never asked for them.
  it('says what counts as named, that builders report it, and that the landing comment says what was written', () => {
    const guide = flat(prose);
    const dispatch = flat(DISPATCH_GUIDE.body);
    expect(guide).toContain(
      'A name the issue, its criteria, its decision or its code gives a thing is a glossary entry',
    );
    expect(guide).toContain('a limit or choice the work settled a rule entry');
    expect(guide).toContain('The landing comment says which you wrote, or why none.');
    expect(guide).not.toContain('Met none, write none');
    expect(dispatch).toContain("each builder's report names them");
    expect(dispatch).toContain('Comment what landed and which you wrote');
    expect(DIRECT_ORDER).toContain("the terms and rules each builder's report names");
    expect(DIRECT_ORDER).toContain('say in the landing comment which you wrote');
  });
});

// ISS-1251 round 5: audit.self had no call from a master or a run in 30 days, and the only text
// naming it was one Tier-0 map line among ten doors; the step where each closes its work teaches it
describe('the step that closes work teaches the self-audit where it is taken', () => {
  const dispatch = DISPATCH_GUIDE.body.split(/\s+/).join(' ');

  it('asks a run, at its report, to audit its own output once against its rubric', () => {
    expect(prose).toContain('Then audit your own output once, as the role you held');
    expect(prose).toContain('`POST /api/projects/:id/self-audits`');
    expect(prose).toContain('criteria_proven, in_scope');
    expect(ISSUE_FLOW_GUIDE.doors).toContain('POST /api/projects/:id/self-audits');
  });

  it('asks a master, at its fold and its direct-mode record, to audit each issue it landed', () => {
    expect(dispatch).toContain('Then audit your own part once per issue you landed or folded');
    expect(dispatch).toContain("{ as: 'master', output: { kind: 'issue', ref }, failed, missed }");
    expect(dispatch).toContain('hand the lease back, and audit the issue as `master` (Fold)');
    expect(DIRECT_ORDER).toContain('then audit each issue you landed once, as master');
  });
});

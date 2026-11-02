import { describe, expect, it } from 'vitest';
import { DISPATCH_GUIDE } from './dispatch-guide.js';

// read as prose, wherever a line wraps
const prose = DISPATCH_GUIDE.body.split(/\s+/).join(' ');

// REQ-79 BC-12, BC-18 (ISS-845, FB-453): direct mode is every fast project outside strict, and it
// lands the way the project lands, so a project whose branches change only by merged MR is never
// pushed past.
describe('the dispatch guide teaches direct mode outside strict, landing by the project route', () => {
  it('selects direct mode by not strict, never by yolo alone', () => {
    expect(prose).toContain('A project whose gate profile is not `strict`');
    expect(prose).not.toContain('A project whose gate profile is `yolo`');
  });

  it('lands through a change request where the project lands by one, and pushes only where it pushes', () => {
    expect(prose).toContain('Land the batch once, by the route its project lands by');
    expect(prose).toContain('`release.changeRequests`');
    expect(prose).toContain('POST /api/projects/:id/integrations/source/change-requests');
    expect(prose).toContain('Push to the base branch only where the project lands by push');
    expect(prose).not.toContain('Push it to the base branch when');
  });
});

// ISS-845, batch-delivery (owner, 2026-11-01): a master works in batches split by files, never
// issue by issue; a batch lands, releases and is judged once, and no issue carries its own ceremony.
describe('the dispatch guide teaches batches by default', () => {
  it('splits a wave by files and folds what arrives mid-wave into it', () => {
    expect(prose).toContain('### 4. Batch by files');
    expect(prose).toContain('an issue that arrives while it runs joins it');
    expect(prose).toContain('issues that touch the same files ride one branch');
    expect(prose).toContain('File overlap and conflict risk are the only bound');
    expect(prose).not.toContain('Two issues that only share a file are neighbours');
    expect(prose).not.toContain('the second waits for the first to land');
  });

  it('lands, releases and judges a direct batch once, with no per-issue ceremony', () => {
    expect(prose).toContain('It works in batches');
    expect(prose).toContain('Land the batch once');
    expect(prose).toContain('No issue gets its own plan, its own full suite or its own release');
    expect(prose).toContain('the assumption written as one line');
    expect(prose).toContain('Release the batch once, on the minimum bar');
    expect(prose).toContain('one live judge pass over the batch');
    expect(prose).toContain('a red there is fixed forward in the next batch');
    expect(prose).not.toContain('For each issue it takes');
    expect(prose).not.toContain('gate profile yolo');
    expect(DISPATCH_GUIDE.summary).not.toContain('yolo');
  });
});

// ISS-861 (owner, 2026-11-01): triage writes what helps the run, and no field is a precondition
// of dispatch that core does not itself hold.
describe('the dispatch guide asks for no triage ritual', () => {
  it('holds no run back on a missing complexity and asks no confirmation record', () => {
    expect(prose).not.toContain('No run is dispatched on an issue holding no `complexity`');
    expect(prose).not.toContain('a `confirmation` record');
    expect(prose).toContain('A candidate that survives goes into the batch');
  });

  it('still names the refusals the box and core hold', () => {
    for (const kernel of ['ISSUE_SCOPE_HELD', 'ISSUE_AT_REST', 'forge-runner run declare']) {
      expect(prose).toContain(kernel);
    }
  });
});

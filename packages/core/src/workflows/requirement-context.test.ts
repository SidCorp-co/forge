import { describe, expect, it } from 'vitest';
import { type RequirementContextRow, requirementContext } from './requirement-context.js';

const ISSUE = '03b63684-76b4-4585-9a77-12b830223ce5';
const API = {
  id: 'e42c7e01-e30c-4a1c-9198-9eb3dccdbf49',
  slug: 'adminhub-api',
  name: 'Adminhub API',
};

const row = (over: Partial<RequirementContextRow> = {}): RequirementContextRow => ({
  requirementId: 'r1',
  key: 'REQ-14',
  issueId: ISSUE,
  projectId: API.id,
  otherProject: API,
  title: 'Order history',
  status: 'agreed',
  currentRevision: 2,
  headState: 'current',
  tldr: null,
  goal: null,
  criteria: [
    { id: 'c6', code: 'BC-6', body: 'A shopper sees every past order', form: 'statement' },
  ],
  baseline: { revision: 2, seq: 1, agreedAt: '2026-10-30T00:00:00.000Z', pins: [], mockups: [] },
  plannedRevision: 2,
  changedTraced: [],
  plan: 'the plan',
  ...over,
});

describe('requirementContext', () => {
  it("names a sibling project's requirement with its project, and where the run reads it", () => {
    const loaded = requirementContext(row());
    expect(loaded?.projectId).toBe(API.id);
    expect(loaded?.text).toContain('adminhub-api/REQ-14 · Order history');
    expect(loaded?.text).toContain(`GET /api/issues/${ISSUE}/requirement`);
    expect(loaded?.text).toContain('(REQ-14 BC-m)');
    expect(loaded?.text).toContain('- BC-6: A shopper sees every past order');
  });

  it("names the issue's own project's requirement by its key alone", () => {
    const loaded = requirementContext(row({ otherProject: null }));
    expect(loaded?.text).toContain('\nREQ-14 · Order history');
    expect(loaded?.text).not.toContain('/requirement`');
  });

  it("points the run at a pinned design through the issue, so a sibling's design reads on its credential", () => {
    const pin = {
      workflowId: '277ed0fd-0d90-4a43-a0e2-ec88a1b88460',
      flow: 'api-keys',
      designRevision: 3,
      contractSlug: null,
      contractVersion: null,
      providerProjectId: null,
    };
    const base = row().baseline;
    const loaded = requirementContext(row({ baseline: base && { ...base, pins: [pin] } }));
    expect(loaded?.text).toContain(
      `forge-runner api issues/${ISSUE}/requirement/designs/${pin.workflowId}?revision=3`,
    );
    expect(loaded?.text).not.toContain('projects/<projectId>/workflows');
  });
});

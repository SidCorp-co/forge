import { REQUIREMENT_SUMMARY_FIELDS } from '@forge/contracts/requirements';
import { SUGGESTION_SUMMARY_FIELDS } from '@forge/contracts/suggestions';
import { WORKFLOW_SUMMARY_FIELDS } from '@forge/contracts/workflows';
import { describe, expect, it, vi } from 'vitest';
import { makeFakeContext, makeFakePrincipal } from '../fake-principal.fixture.js';
import { toToolCallContent } from '../tool-result.js';
import {
  dischargeDesign,
  requirementDetail,
  requirementList,
  suggestionList,
  WORKFLOW_ID,
  workflowRow,
} from './answer-size.fixture.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';

vi.mock('./lib.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib.js')>()),
  resolveEffectiveProjectId: async () => PROJECT,
}));

const requirementOutcome = async () => ({ ok: true, requirement: requirementDetail() });
vi.mock('../../project-config/service.js', () => ({
  readProjectDocument: async () => null,
}));

vi.mock('../../requirements/read.js', () => ({
  listRequirementsAs: async () => requirementList(),
  readRequirementAs: async () => requirementDetail(),
}));
vi.mock('../../requirements/issue-links.js', () => ({
  linkIssue: requirementOutcome,
  unlinkIssue: requirementOutcome,
  linkWorkflow: requirementOutcome,
  unlinkWorkflow: requirementOutcome,
}));
vi.mock('../../requirements/service.js', () => ({
  createRequirement: requirementOutcome,
  writeRevision: requirementOutcome,
  proposeRevision: requirementOutcome,
  acceptRevision: requirementOutcome,
  returnRevision: requirementOutcome,
  agreeRequirement: requirementOutcome,
}));

const designOutcome = async () => ({ ok: true, design: dischargeDesign() });
vi.mock('../../workflows/design-service.js', () => ({
  readDesignAs: async () => dischargeDesign(),
  proposeDesign: designOutcome,
  decideDesignAs: designOutcome,
  linkBuildAs: designOutcome,
  unlinkBuildAs: designOutcome,
}));
vi.mock('../../workflows/service.js', () => ({
  listWorkflowsAs: async () => Array.from({ length: 5 }, workflowRow),
  readWorkflowAs: async () => workflowRow(),
  createWorkflow: async () => ({ ok: true, row: {}, document: {}, created: true }),
  updateWorkflow: async () => ({ ok: true, row: {}, document: {}, created: false }),
  workflowView: () => workflowRow(),
}));
vi.mock('../../workflows/template-service.js', () => ({
  listProjectTemplatesAs: async () => [],
  readProjectTemplateAs: async () => ({}),
}));

vi.mock('../../suggestions/read.js', () => ({
  listSuggestions: async () => ({ suggestions: suggestionList(), open: 0 }),
}));
const suggestionOutcome = async () => ({ ok: true, suggestion: suggestionList()[0] });
vi.mock('../../suggestions/service.js', () => ({
  createSuggestion: suggestionOutcome,
  acceptSuggestion: suggestionOutcome,
  rejectSuggestion: suggestionOutcome,
  withdrawSuggestion: suggestionOutcome,
}));

const { forgeRequirementsTool } = await import('./forge-requirements.js');
const { forgeWorkflowsTool } = await import('./forge-workflows.js');
const { forgeSuggestionsTool } = await import('./forge-suggestions.js');

const ctx = makeFakeContext(
  makeFakePrincipal('tok', '33333333-3333-4333-8333-333333333333', { agency: 'agent' }),
);

type Tool = typeof forgeRequirementsTool;

async function answer(tool: Tool, args: Record<string, unknown>) {
  const value = (await tool(ctx).handler({ projectId: PROJECT, ...args })) as Record<
    string,
    unknown
  >;
  const block = toToolCallContent(value).content[0] as { text: string };
  return { value, chars: block.text.length };
}

const KB = 1_024;
const LIST_ROW = 1_500;
const ACT = 4 * KB;

describe('the discharge-post-care fixture is the size ISS-87 measured', () => {
  it('reads as the whole-document answers did before the projection', async () => {
    const design = await answer(forgeWorkflowsTool, {
      action: 'design',
      workflowId: WORKFLOW_ID,
      view: 'full',
    });
    expect(design.chars).toBeGreaterThan(150_000);
    const detail = await answer(forgeRequirementsTool, {
      action: 'get',
      requirement: 'REQ-1',
    });
    expect(detail.chars).toBeGreaterThan(20_000);
  });
});

describe('forge_workflows answers a projection unless view is full', () => {
  it('list carries the summary fields and no document', async () => {
    const { value, chars } = await answer(forgeWorkflowsTool, { action: 'list' });
    const rows = value.workflows as Record<string, unknown>[];
    for (const row of rows) expect(Object.keys(row)).toEqual([...WORKFLOW_SUMMARY_FIELDS]);
    expect(value.view).toBe('summary');
    expect(chars, 'forge_workflows list').toBeLessThan(rows.length * LIST_ROW);
  });

  it('design answers the revision history without documents', async () => {
    const { value, chars } = await answer(forgeWorkflowsTool, {
      action: 'design',
      workflowId: WORKFLOW_ID,
    });
    const revisions = value.revisions as Record<string, unknown>[];
    expect(revisions.map((r) => r.revision)).toEqual([6, 5, 4, 3, 2]);
    expect(revisions.every((r) => !('document' in r) && r.stepCount === 15)).toBe(true);
    expect(chars, 'forge_workflows design').toBeLessThan(ACT);
  });

  for (const act of ['link', 'unlink', 'propose', 'decide'] as const) {
    it(`${act} answers what it changed, under a few KB`, async () => {
      const { value, chars } = await answer(forgeWorkflowsTool, {
        action: act,
        workflowId: WORKFLOW_ID,
        issue: 'ISS-100',
        revision: 6,
        decision: 'approve',
        reason: 'fits',
      });
      expect(chars, `forge_workflows ${act}`).toBeLessThan(ACT);
      expect(value.act).toBe(act);
      expect(JSON.stringify(value)).not.toContain('"document"');
    });
  }

  it('write answers the new revision, not the document it was sent', async () => {
    const { value, chars } = await answer(forgeWorkflowsTool, {
      action: 'write',
      workflowId: WORKFLOW_ID,
      baseRevision: 5,
      document: {},
    });
    expect(value).toMatchObject({ workflowId: WORKFLOW_ID, revision: 6, created: false });
    expect(chars, 'forge_workflows write').toBeLessThan(KB);
  });

  it('view full answers the whole design, every revision with its document', async () => {
    const { value } = await answer(forgeWorkflowsTool, {
      action: 'link',
      workflowId: WORKFLOW_ID,
      issue: 'ISS-100',
      view: 'full',
    });
    expect((value.revisions as { document: unknown }[]).every((r) => r.document)).toBe(true);
  });

  it('view steps answers one revision, bounded by stepFrom and stepTo', async () => {
    const { value, chars } = await answer(forgeWorkflowsTool, {
      action: 'design',
      workflowId: WORKFLOW_ID,
      view: 'steps',
      revision: 5,
      stepFrom: 3,
      stepTo: 4,
    });
    const doc = value.document as { revision: number; steps: { id: string }[]; stepCount: number };
    expect(doc.revision).toBe(5);
    expect(doc.stepCount).toBe(15);
    expect(doc.steps.map((s) => s.id)).toEqual(['step-3', 'step-4']);
    const edges = (value.document as { edges: { from: string; to: string }[] }).edges;
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges)
      expect([e.from, e.to].some((id) => ['step-3', 'step-4'].includes(id))).toBe(true);
    expect(chars, 'forge_workflows design steps 3-4').toBeLessThan(16 * KB);
  });

  it('view steps names the revisions it holds when asked for one it does not', async () => {
    await expect(
      answer(forgeWorkflowsTool, {
        action: 'design',
        workflowId: WORKFLOW_ID,
        view: 'steps',
        revision: 9,
      }),
    ).rejects.toThrow(/proposed no revision 9; its revisions are 6, 5, 4, 3, 2/);
  });

  it('refuses a step range that is not one, by name', async () => {
    await expect(
      answer(forgeWorkflowsTool, {
        action: 'design',
        workflowId: WORKFLOW_ID,
        view: 'steps',
        stepFrom: 5,
        stepTo: 4,
      }),
    ).rejects.toThrow(/stepFrom 5 to stepTo 4 is not a range of revision 6, which has 15 steps/);
    await expect(
      answer(forgeWorkflowsTool, {
        action: 'design',
        workflowId: WORKFLOW_ID,
        view: 'steps',
        stepFrom: 16,
      }),
    ).rejects.toThrow(/stepFrom 16/);
  });

  it('refuses steps outside design, and a range without view steps', async () => {
    await expect(answer(forgeWorkflowsTool, { action: 'list', view: 'steps' })).rejects.toThrow(
      "BAD_REQUEST: view 'steps' reads a design; list takes view summary or full",
    );
    await expect(
      answer(forgeWorkflowsTool, { action: 'design', workflowId: WORKFLOW_ID, stepFrom: 2 }),
    ).rejects.toThrow(/stepFrom and stepTo bound view 'steps'/);
  });
});

describe('forge_requirements answers a projection unless view is full', () => {
  it('list carries the summary fields and no criterion body', async () => {
    const { value, chars } = await answer(forgeRequirementsTool, { action: 'list' });
    const rows = value.requirements as Record<string, unknown>[];
    for (const row of rows) expect(Object.keys(row)).toEqual([...REQUIREMENT_SUMMARY_FIELDS]);
    expect(JSON.stringify(rows)).not.toContain('"coverage"');
    expect(chars, 'forge_requirements list').toBeLessThan(rows.length * LIST_ROW);
  });

  for (const act of ['link_issue', 'unlink_issue', 'link_workflow', 'unlink_workflow'] as const) {
    it(`${act} answers the links it changed, under a few KB`, async () => {
      const { value, chars } = await answer(forgeRequirementsTool, {
        action: act,
        requirement: 'REQ-1',
        issue: 'ISS-200',
        workflowId: WORKFLOW_ID,
      });
      expect(chars, `forge_requirements ${act}`).toBeLessThan(ACT);
      expect(value.act).toBe(act);
      expect(value).not.toHaveProperty('revisions');
      expect(value).not.toHaveProperty('history');
    });
  }

  for (const act of ['propose', 'accept', 'return', 'agree'] as const) {
    it(`${act} answers the decided revision without its criteria`, async () => {
      const { value, chars } = await answer(forgeRequirementsTool, {
        action: act,
        requirement: 'REQ-1',
        revision: 2,
        reason: 'because',
      });
      expect((value.revision as { revision: number }).revision).toBe(2);
      expect(value.revision).not.toHaveProperty('criteria');
      expect(chars, `forge_requirements ${act}`).toBeLessThan(2 * KB);
    });
  }

  it('revise answers the revision it wrote with its criteria codes', async () => {
    const { value, chars } = await answer(forgeRequirementsTool, {
      action: 'revise',
      requirement: 'REQ-1',
      baseRevision: 2,
      reason: 'sharper',
      criteria: [{ body: 'a body' }],
    });
    const revision = value.revision as { revision: number; criteria: { code: string }[] };
    expect(revision.revision).toBe(3);
    expect(revision.criteria.map((c) => c.code)).toContain('BC-12');
    expect(chars, 'forge_requirements revise').toBeLessThan(ACT * 2);
  });

  it('get answers whole by default and the summary on request', async () => {
    const whole = await answer(forgeRequirementsTool, { action: 'get', requirement: 'REQ-1' });
    expect(whole.value).toHaveProperty('history');
    const summary = await answer(forgeRequirementsTool, {
      action: 'get',
      requirement: 'REQ-1',
      view: 'summary',
    });
    expect(Object.keys(summary.value)).toEqual([...REQUIREMENT_SUMMARY_FIELDS]);
  });

  it('view full answers the whole requirement on a write', async () => {
    const { value } = await answer(forgeRequirementsTool, {
      action: 'link_issue',
      requirement: 'REQ-1',
      issue: 'ISS-200',
      view: 'full',
    });
    expect(value).toHaveProperty('history');
  });
});

describe('forge_suggestions answers a projection unless view is full', () => {
  it('list carries no payload, fingerprint or reason', async () => {
    const { value, chars } = await answer(forgeSuggestionsTool, { action: 'list' });
    const rows = value.suggestions as Record<string, unknown>[];
    for (const row of rows) expect(Object.keys(row)).toEqual([...SUGGESTION_SUMMARY_FIELDS]);
    expect(chars, 'forge_suggestions list').toBeLessThan(rows.length * 600);
  });

  it('a write answers the summary of the suggestion it wrote', async () => {
    const { value, chars } = await answer(forgeSuggestionsTool, {
      action: 'withdraw',
      suggestionId: '66666666-6666-4666-8666-000000000000',
    });
    expect(value.suggestion).not.toHaveProperty('payload');
    expect(chars, 'forge_suggestions withdraw').toBeLessThan(KB);
  });

  it('view full answers each payload', async () => {
    const { value } = await answer(forgeSuggestionsTool, { action: 'list', view: 'full' });
    expect((value.suggestions as { payload: unknown }[]).every((s) => s.payload)).toBe(true);
  });
});

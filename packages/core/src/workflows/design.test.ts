import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decisionRefusals,
  designApproverRefusal,
  designFingerprint,
  designStatusAfterWrite,
  designStatusAtCreate,
  proposeRefusal,
} from './design.js';
import { parseWorkflow } from './rules.js';
import type { WorkflowWrite } from './schema.js';

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
type Doc = Record<string, any>;

const PROJECT = '5e1d7c3a-2b4f-4a6e-9c8d-0f1e2a3b4c5d';
const design = (): Doc =>
  JSON.parse(
    readFileSync(new URL('./fixtures/post-discharge.design.json', import.meta.url), 'utf8'),
  );
const parsed = (d: Doc): WorkflowWrite => {
  const r = parseWorkflow(d, PROJECT);
  if (!r.ok) throw new Error(JSON.stringify(r.refusals));
  return r.value;
};

const agent = (role: 'member' | 'viewer' | null) => ({
  userId: 'a',
  agency: 'agent' as const,
  role,
  orgRole: null,
});
const person = (orgRole: 'owner' | 'admin' | 'member' | null) => ({
  userId: 'p',
  agency: 'human' as const,
  role: 'member' as const,
  orgRole,
});

describe('who decides a workflow design', () => {
  it('refuses an agent while the approver is the owner, even the project master', () => {
    expect(designApproverRefusal(agent('member'), PROJECT, 'owner')?.code).toBe(
      'WORKFLOW_DESIGN_APPROVER_NOT_PERSON',
    );
  });

  it("lets the project's own master decide once the approver is master", () => {
    expect(designApproverRefusal(agent('member'), PROJECT, 'master')).toBeNull();
  });

  it("refuses another project's agent, and this project's viewer agent, with approver master", () => {
    expect(designApproverRefusal(agent(null), PROJECT, 'master')?.code).toBe(
      'WORKFLOW_DESIGN_APPROVER_NOT_PROJECT',
    );
    expect(designApproverRefusal(agent('viewer'), PROJECT, 'master')?.code).toBe(
      'WORKFLOW_DESIGN_APPROVER_NOT_PROJECT',
    );
  });

  it.each(['owner', 'master'] as const)(
    'admits an org owner or admin person under %s, and refuses an org member',
    (approver) => {
      expect(designApproverRefusal(person('owner'), PROJECT, approver)).toBeNull();
      expect(designApproverRefusal(person('admin'), PROJECT, approver)).toBeNull();
      expect(designApproverRefusal(person('member'), PROJECT, approver)?.code).toBe(
        'WORKFLOW_DESIGN_APPROVER_NOT_ADMIN',
      );
    },
  );
});

describe('the design lifecycle', () => {
  it('starts a v2 workflow as a draft and leaves a v1 one outside the lifecycle', () => {
    expect(designStatusAtCreate(parsed(design()))).toBe('draft');
    const v1 = { ...parsed(design()), version: 1 } as unknown as WorkflowWrite;
    expect(designStatusAtCreate(v1)).toBeNull();
  });

  it('sends a changed design back to proposed after any decision, and leaves a draft a draft', () => {
    for (const from of ['proposed', 'approved', 'returned'] as const) {
      expect(designStatusAfterWrite(from, true)).toEqual({ status: 'proposed', proposes: true });
      expect(designStatusAfterWrite(from, false)).toEqual({ status: from, proposes: false });
    }
    expect(designStatusAfterWrite('draft', true)).toEqual({ status: 'draft', proposes: false });
  });

  it('fingerprints the design and not the reading: evidence and status move nothing', () => {
    const base = designFingerprint(parsed(design()));
    const built = design();
    built.status = 'writing';
    built.steps[0].status = 'current';
    built.steps[0].evidence = {
      kind: 'storefront',
      provider: 'autoflow',
      ref: 'workflow',
      id: 'post_discharge',
    };
    expect(designFingerprint(parsed(built))).toBe(base);
    const moved = design();
    moved.edges[0].onFailure = 'retry_then_attention';
    expect(designFingerprint(parsed(moved))).not.toBe(base);
    const retyped = design();
    retyped.steps[3].node.type = 'TASK';
    expect(designFingerprint(parsed(retyped))).not.toBe(base);
  });

  it('fingerprints a feedback edge as design, and an explicit flow kind as no change', () => {
    const base = designFingerprint(parsed(design()));
    const flowNamed = design();
    flowNamed.edges[0].kind = 'flow';
    expect(designFingerprint(parsed(flowNamed))).toBe(base);
    const looped = design();
    looped.edges.push({
      kind: 'feedback',
      from: 'outcome',
      to: 'followup-rule',
      reevaluates: 'follow-up rule',
      condition: 'true',
      action: 'reevaluate',
      mapping: {},
      idempotency: 'one per outcome',
      onFailure: 'create_attention_item',
    });
    const withLoop = designFingerprint(parsed(looped));
    expect(withLoop).not.toBe(base);
    looped.edges[1].reevaluates = 'follow-up and escalation rules';
    expect(designFingerprint(parsed(looped))).not.toBe(withLoop);
  });

  it('proposes only a draft, naming why anything else is refused', () => {
    expect(proposeRefusal('draft', 'w')).toBeNull();
    expect(proposeRefusal('proposed', 'w')?.code).toBe('WORKFLOW_DESIGN_ALREADY_PROPOSED');
    expect(proposeRefusal('approved', 'w')?.code).toBe('WORKFLOW_DESIGN_ALREADY_APPROVED');
    expect(proposeRefusal('returned', 'w')?.code).toBe('WORKFLOW_DESIGN_UNCHANGED');
  });

  it('decides only the revision awaiting a decision, and a return says why', () => {
    const at = { status: 'proposed' as const, proposedRevision: 3, revision: 3 };
    expect(decisionRefusals({ ...at, decision: 'approve', reason: null })).toEqual([]);
    expect(
      decisionRefusals({ ...at, revision: 2, decision: 'approve', reason: null }).map(
        (r) => r.code,
      ),
    ).toEqual(['WORKFLOW_DESIGN_REVISION_STALE']);
    expect(
      decisionRefusals({ ...at, decision: 'return', reason: '  ' }).map((r) => r.code),
    ).toEqual(['WORKFLOW_DESIGN_REASON_MISSING']);
    expect(
      decisionRefusals({ ...at, status: 'approved', decision: 'approve', reason: null }).map(
        (r) => r.code,
      ),
    ).toEqual(['WORKFLOW_DESIGN_NOT_PROPOSED']);
  });
});

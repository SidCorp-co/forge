import { readFileSync } from 'node:fs';
import { BUILTIN_WORKFLOW_TEMPLATES, findTemplate } from '@forge/contracts/workflow-templates';
import { describe, expect, it } from 'vitest';
import { designFingerprint } from './design.js';
import { baseApprovalRefusal, baseRefusals, basesOfStored, readBases } from './design-bases.js';
import { parseWorkflow } from './rules.js';
import type { WorkflowWrite } from './schema.js';

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
type Doc = Record<string, any>;

const PROJECT = '5e1d7c3a-2b4f-4a6e-9c8d-0f1e2a3b4c5d';
const OPERATIONAL = findTemplate(BUILTIN_WORKFLOW_TEMPLATES, {
  id: 'operational-flow',
  version: 1,
});
const design = (patch: (d: Doc) => void = () => {}): WorkflowWrite => {
  const d: Doc = JSON.parse(
    readFileSync(new URL('./fixtures/post-discharge.design.json', import.meta.url), 'utf8'),
  );
  d.project = PROJECT;
  patch(d);
  const r = parseWorkflow(d, PROJECT);
  if (!r.ok) throw new Error(JSON.stringify(r.refusals));
  return r.value;
};
const based = (bases: Array<{ workflow: string; revision: number }>) =>
  design((d) => {
    d.basedOn = bases;
  });
const flowOf = design().flow;
const held = [
  { flow: flowOf, revision: 3 },
  { flow: 'hop-audit-provenance', revision: 4 },
  { flow: 'hop-access-decision', revision: 5 },
];

describe('basedOn at write (FB-51)', () => {
  it('admits bases the project holds, at revisions they held', () => {
    expect(
      baseRefusals(
        based([
          { workflow: 'hop-audit-provenance', revision: 4 },
          { workflow: 'hop-access-decision', revision: 2 },
        ]),
        held,
      ),
    ).toEqual([]);
  });

  it('refuses a design naming itself as its base', () => {
    const [r] = baseRefusals(based([{ workflow: flowOf, revision: 1 }]), held);
    expect(r).toMatchObject({ code: 'WORKFLOW_BASE_SELF', path: '/basedOn/0' });
  });

  it('refuses a flow the project does not hold, listing the ones it does', () => {
    const [r] = baseRefusals(based([{ workflow: 'hop-ghost', revision: 1 }]), held);
    expect(r?.code).toBe('WORKFLOW_BASE_UNKNOWN');
    expect(r?.detail).toContain('hop-audit-provenance, hop-access-decision');
  });

  it('refuses a revision the base never held', () => {
    const [r] = baseRefusals(based([{ workflow: 'hop-audit-provenance', revision: 9 }]), held);
    expect(r?.code).toBe('WORKFLOW_BASE_UNKNOWN');
    expect(r?.detail).toContain('stands at revision 4');
  });

  it('refuses one base named twice', () => {
    const refusals = baseRefusals(
      based([
        { workflow: 'hop-audit-provenance', revision: 3 },
        { workflow: 'hop-audit-provenance', revision: 4 },
      ]),
      held,
    );
    expect(refusals.map((r) => [r.code, r.path])).toEqual([
      ['WORKFLOW_BASE_DUPLICATE', '/basedOn/1'],
    ]);
  });

  it('refuses a base with no revision or a revision below 1 at the schema', () => {
    for (const bad of [{ workflow: 'hop-audit-provenance' }, { workflow: 'x', revision: 0 }]) {
      const d: Doc = JSON.parse(
        readFileSync(new URL('./fixtures/post-discharge.design.json', import.meta.url), 'utf8'),
      );
      d.project = PROJECT;
      d.basedOn = [bad];
      expect(parseWorkflow(d, PROJECT).ok).toBe(false);
    }
  });

  it('is part of the design its approver decides, and absent it moves no fingerprint', () => {
    const plain = designFingerprint(design(), OPERATIONAL);
    expect(designFingerprint(design(), OPERATIONAL)).toBe(plain);
    expect(
      designFingerprint(based([{ workflow: 'hop-audit-provenance', revision: 4 }]), OPERATIONAL),
    ).not.toBe(plain);
  });

  it('reads the bases a stored revision declares, and none from a document that declares none', () => {
    expect(basesOfStored(based([{ workflow: 'hop-access-decision', revision: 5 }]))).toEqual([
      { workflow: 'hop-access-decision', revision: 5 },
    ]);
    expect(basesOfStored(design())).toEqual([]);
    expect(basesOfStored(null)).toEqual([]);
  });
});

describe('approving a design on its bases (FB-51)', () => {
  const rows = [
    { flow: 'hop-audit-provenance', designStatus: 'returned' as const, approvedRevision: 1 },
    { flow: 'hop-access-decision', designStatus: 'approved' as const, approvedRevision: 5 },
    { flow: 'hop-business-rules', designStatus: 'proposed' as const, approvedRevision: null },
  ];

  it('admits the approval when every base is approved at the revision it names', () => {
    expect(
      baseApprovalRefusal(3, readBases([{ workflow: 'hop-access-decision', revision: 5 }], rows)),
    ).toBeNull();
  });

  it('refuses it WORKFLOW_DESIGN_BASE_UNAPPROVED while a base revision is returned, naming its state', () => {
    const r = baseApprovalRefusal(
      3,
      readBases([{ workflow: 'hop-audit-provenance', revision: 2 }], rows),
    );
    expect(r?.code).toBe('WORKFLOW_DESIGN_BASE_UNAPPROVED');
    expect(r?.detail).toContain(
      '"hop-audit-provenance" rev 2, which is returned, with approved revision 1',
    );
  });

  it('names every unapproved base: one never approved, one missing, one approved at another revision', () => {
    const r = baseApprovalRefusal(
      2,
      readBases(
        [
          { workflow: 'hop-business-rules', revision: 1 },
          { workflow: 'hop-gone', revision: 1 },
          { workflow: 'hop-access-decision', revision: 4 },
        ],
        rows,
      ),
    );
    expect(r?.detail).toContain(
      '"hop-business-rules" rev 1, which is proposed, with no approved revision',
    );
    expect(r?.detail).toContain('"hop-gone" rev 1, which is no workflow of this project');
    expect(r?.detail).toContain(
      '"hop-access-decision" rev 4, which is approved, with approved revision 5',
    );
  });
});

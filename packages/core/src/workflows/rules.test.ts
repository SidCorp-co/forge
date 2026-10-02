import { readFileSync } from 'node:fs';
import { BUILTIN_WORKFLOW_TEMPLATES } from '@forge/contracts/workflow-templates';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { workflowJsonSchemas } from './json-schema.js';
import {
  checkWorkflow,
  evidenceSourceRefusals,
  parseWorkflow,
  workflowIdentityRefusals,
  workflowWriterRefusal,
} from './rules.js';
import { WORKFLOW_LIMITS, type WorkflowWrite } from './schema.js';

const CTX = { templates: BUILTIN_WORKFLOW_TEMPLATES, designs: new Map() };

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
type Doc = Record<string, any>;

const PROJECT = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';
const OTHER = '8f4c3d6b-ae5a-4b1d-8243-5d6e7f8091a3';
const SHA = 'e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510';

const example = (file: string): Doc =>
  JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'));
const release = () => example('release.workflow.json');
const issueStatus = () => example('issue-status.workflow.json');

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const emitted = ajv.compile(workflowJsonSchemas['workflow-v1.json'] as object);
const stamped = (d: Doc) => ({
  ...d,
  id: 'c17f6a9e-1d2b-4c3a-8e4f-5a6b7c8d9e01',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
});

function refusalsOf(raw: Doc) {
  const parsed = parseWorkflow(raw, PROJECT);
  return parsed.ok ? checkWorkflow(parsed.value, CTX) : parsed.refusals;
}
const codesAt = (raw: Doc) => refusalsOf(raw).map((r) => `${r.code} ${r.path}`);
const withDoc = (base: () => Doc, patch: (d: Doc) => void) => {
  const d = base();
  patch(d);
  return d;
};

describe('a workflow the project agent writes', () => {
  it.each([
    ['a flow', release],
    ['a state machine', issueStatus],
  ])('is accepted whole as %s, and its record by the emitted schema', (_, build) => {
    expect(refusalsOf(build())).toEqual([]);
    expect(emitted(stamped(build()))).toBe(true);
  });

  it('may stand with a step being written that has no evidence yet', () => {
    const d = withDoc(release, (x) => {
      x.status = 'writing';
      x.steps[3].status = 'writing';
      x.steps[3].evidence = null;
    });
    expect(refusalsOf(d)).toEqual([]);
  });

  it('may be re-checking the steps a commit moved under', () => {
    const d = withDoc(release, (x) => {
      x.status = 'rechecking';
      x.steps[3].status = 'rechecking';
      x.drift = { sha: SHA, steps: ['reap'], reason: 'runs-cascade.ts changed in e7af418' };
    });
    expect(refusalsOf(d)).toEqual([]);
  });

  it('holds its step list at the bound and refuses one past it', () => {
    const many = (n: number) =>
      withDoc(issueStatus, (x) => {
        x.steps = Array.from({ length: n }, (_, i) => ({
          id: `s${i}`,
          does: 'a state',
          status: 'current',
          after: i === 0 ? [] : [`s${i - 1}`],
          evidence: null,
        }));
      });
    expect(refusalsOf(many(WORKFLOW_LIMITS.steps))).toEqual([]);
    expect(codesAt(many(WORKFLOW_LIMITS.steps + 1))).toEqual(['SCHEMA_VIOLATION /steps']);
  });
});

const plants: [string, () => Doc, string][] = [
  [
    'an after edge that closes a loop',
    () => withDoc(release, (d) => (d.steps[0].after = ['reap'])),
    'WORKFLOW_AFTER_CYCLE /steps/0/after',
  ],
  [
    'a step that comes after itself',
    () => withDoc(release, (d) => (d.steps[2].after = ['deploy'])),
    'WORKFLOW_AFTER_CYCLE /steps/2/after',
  ],
  [
    'an after edge naming no step',
    () => withDoc(release, (d) => (d.steps[1].after = ['merge'])),
    'WORKFLOW_AFTER_DANGLING /steps/1/after/0',
  ],
  [
    'an absolute evidence path',
    () => withDoc(release, (d) => (d.steps[0].evidence.file = '/etc/passwd')),
    'PATH_OUTSIDE_REPO /steps/0/evidence/file',
  ],
  [
    'an evidence path that climbs out of the repo',
    () => withDoc(release, (d) => (d.steps[1].evidence.file = 'packages/../../secrets.env')),
    'PATH_OUTSIDE_REPO /steps/1/evidence/file',
  ],
  [
    'a drive-rooted evidence path',
    () => withDoc(release, (d) => (d.steps[2].evidence.file = 'C:/src/a.ts')),
    'PATH_OUTSIDE_REPO /steps/2/evidence/file',
  ],
  [
    'a kind outside the enum',
    () => withDoc(release, (d) => (d.kind = 'diagram')),
    'WORKFLOW_KIND_UNKNOWN /kind',
  ],
  [
    'a workflow status outside the enum',
    () => withDoc(release, (d) => (d.status = 'stale')),
    'WORKFLOW_STATUS_UNKNOWN /status',
  ],
  [
    'a step status outside the enum',
    () => withDoc(release, (d) => (d.steps[1].status = 'done')),
    'WORKFLOW_STATUS_UNKNOWN /steps/1/status',
  ],
  [
    'a coverage reading outside the enum',
    () => withDoc(release, (d) => (d.steps[0].evidence.coverage.reading = 'covered')),
    'WORKFLOW_COVERAGE_UNKNOWN /steps/0/evidence/coverage/reading',
  ],
  [
    'a walked reading that names no commit',
    () => withDoc(release, (d) => (d.steps[0].evidence.coverage.atSha = null)),
    'WORKFLOW_COVERAGE_UNPINNED /steps/0/evidence/coverage/atSha',
  ],
  [
    'a step named twice',
    () => withDoc(release, (d) => (d.steps[3].id = 'close')),
    'WORKFLOW_STEP_DUPLICATE /steps/3/id',
  ],
  [
    'an annotation of another flow',
    () => withDoc(release, (d) => (d.steps[0].evidence.annotation = 'dispatch/stamp')),
    'WORKFLOW_ANNOTATION_MISMATCH /steps/0/evidence/annotation',
  ],
  [
    'a current flow step with no evidence',
    () => withDoc(release, (d) => (d.steps[2].evidence = null)),
    'WORKFLOW_EVIDENCE_MISSING /steps/2/evidence',
  ],
  [
    'a current workflow holding a step still being written',
    () =>
      withDoc(release, (d) => {
        d.steps[3].status = 'writing';
      }),
    'WORKFLOW_STATUS_MISMATCH /status',
  ],
  [
    'a re-check that names no drift',
    () =>
      withDoc(release, (d) => {
        d.status = 'rechecking';
        d.steps[3].status = 'rechecking';
      }),
    'WORKFLOW_DRIFT_MISMATCH /drift',
  ],
  [
    'drift naming a step that is not there',
    () =>
      withDoc(release, (d) => {
        d.status = 'rechecking';
        d.steps[3].status = 'rechecking';
        d.drift = { sha: SHA, steps: ['reap', 'merge'], reason: 'moved' };
      }),
    'WORKFLOW_DRIFT_STEP_UNKNOWN /drift/steps/1',
  ],
  [
    'a workflow naming another project',
    () => withDoc(release, (d) => (d.project = OTHER)),
    'PROJECT_ID_IMMUTABLE /project',
  ],
  [
    'a write that sets the id core assigns',
    () => ({ ...release(), id: 'c17f6a9e-1d2b-4c3a-8e4f-5a6b7c8d9e01' }),
    'UNKNOWN_KEY /id',
  ],
];

describe('every planted workflow is refused by its own code, and by nothing that passes it', () => {
  it.each(plants)('%s', (_name, build, expected) => {
    expect(codesAt(build())).toEqual([expected]);
  });

  const shapeOnly = plants.filter(([, , e]) =>
    /^(PATH_OUTSIDE_REPO|WORKFLOW_KIND_UNKNOWN|WORKFLOW_STATUS_UNKNOWN|WORKFLOW_COVERAGE_UNKNOWN) /.test(
      e,
    ),
  );
  it.each(shapeOnly)('the emitted schema refuses %s too', (_name, build) => {
    expect(emitted(stamped(build()))).toBe(false);
  });

  it('accepts a dotted file name that does not climb', () => {
    const d = withDoc(release, (x) => (x.steps[0].evidence.file = '.github/workflows/a..b.yml'));
    expect(refusalsOf(d)).toEqual([]);
  });

  it('names the loop it found, in the order the steps run', () => {
    const [r] = refusalsOf(withDoc(release, (d) => (d.steps[0].after = ['reap'])));
    expect(r?.detail).toContain('stamp → close → reap → stamp');
  });
});

describe('who writes a workflow', () => {
  const at = (agency: 'agent' | 'human', role: 'viewer' | 'member' | 'admin' | null) =>
    workflowWriterRefusal({ userId: 'u', agency, role }, PROJECT)?.code ?? null;

  it("is the project's own agent at member or above", () => {
    expect(at('agent', 'member')).toBeNull();
    expect(at('agent', 'admin')).toBeNull();
  });

  it('is never a person, a viewer agent or an agent with no role on the project', () => {
    expect(at('human', 'admin')).toBe('WORKFLOW_WRITER_NOT_PROJECT');
    expect(at('agent', 'viewer')).toBe('WORKFLOW_WRITER_NOT_PROJECT');
    expect(at('agent', null)).toBe('WORKFLOW_WRITER_NOT_PROJECT');
  });
});

describe('a refreshed workflow keeps what it draws', () => {
  const stored = (): WorkflowWrite => {
    const p = parseWorkflow(release(), PROJECT);
    if (!p.ok) throw new Error('the fixture workflow does not parse');
    return p.value;
  };

  it('accepts new steps and a new sha on the same flow', () => {
    const next = { ...stored(), refreshedAtSha: 'a'.repeat(40) };
    expect(workflowIdentityRefusals(stored(), next)).toEqual([]);
  });

  it('refuses a renamed flow or a changed kind by name', () => {
    const next: WorkflowWrite = { ...stored(), flow: 'shipping', kind: 'state' };
    expect(workflowIdentityRefusals(stored(), next).map((r) => `${r.code} ${r.path}`)).toEqual([
      'WORKFLOW_IDENTITY_IMMUTABLE /flow',
      'WORKFLOW_IDENTITY_IMMUTABLE /kind',
    ]);
  });
});

describe('a workflow-v2 design', () => {
  const HOP = '5e1d7c3a-2b4f-4a6e-9c8d-0f1e2a3b4c5d';
  const design = () => example('post-discharge.design.json');
  const emittedV2 = ajv.compile(workflowJsonSchemas['workflow-v2.json'] as object);
  const refusalsAt = (raw: Doc) => {
    const parsed = parseWorkflow(raw, HOP);
    return (parsed.ok ? checkWorkflow(parsed.value, CTX) : parsed.refusals).map(
      (r) => `${r.code} ${r.path}`,
    );
  };
  const storefront = { kind: 'storefront', provider: 'autoflow' } as const;
  const sourceRefusals = (raw: Doc, source: Parameters<typeof evidenceSourceRefusals>[1]) => {
    const parsed = parseWorkflow(raw, HOP);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
    return evidenceSourceRefusals(parsed.value, source).map((r) => `${r.code} ${r.path}`);
  };

  it('stands before any code: designed steps, no evidence, no commit; the emitted schema agrees', () => {
    expect(refusalsAt(design())).toEqual([]);
    expect(emittedV2(stamped(design()))).toBe(true);
  });

  it.each([
    [
      'an unknown node type',
      (d: Doc) => (d.steps[0].node.type = 'TRIGGER'),
      'WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE /steps/0/node/type',
    ],
    [
      'an edge to no step',
      (d: Doc) => d.edges.push({ ...d.edges[3], to: 'nowhere' }),
      'WORKFLOW_EDGE_DANGLING /edges/8/to',
    ],
    [
      'an edge contract for a line the steps do not draw',
      (d: Doc) => d.edges.push({ ...d.edges[3], from: 'discharged' }),
      'WORKFLOW_EDGE_UNDRAWN /edges/8',
    ],
    [
      'a cycle',
      (d: Doc) => (d.steps[0].after = ['outcome']),
      'WORKFLOW_AFTER_CYCLE /steps/0/after',
    ],
    [
      'an evidence that names no kind',
      (d: Doc) => (d.steps[0].evidence = { id: 'x', ref: 'node', provider: 'autoflow' }),
      'WORKFLOW_EVIDENCE_KIND_UNKNOWN /steps/0/evidence/kind',
    ],
    [
      'a designed workflow with a step being built',
      (d: Doc) => (d.steps[0].status = 'writing'),
      'WORKFLOW_STATUS_MISMATCH /status',
    ],
    [
      'a built step with no evidence',
      (d: Doc) => {
        d.status = 'writing';
        d.steps[0].status = 'current';
      },
      'WORKFLOW_EVIDENCE_MISSING /steps/0/evidence',
    ],
  ])('refuses %s by name', (_name, patch, expected) => {
    const d = design();
    patch(d);
    expect(refusalsAt(d)).toEqual([expected]);
  });

  it('refuses `designed` at version 1, which never had it', () => {
    const d = release();
    d.steps[0].status = 'designed';
    expect(codesAt(d)).toContain('WORKFLOW_STATUS_UNKNOWN /steps/0/status');
  });

  it("refuses a repo file as a storefront project's evidence, and a storefront artefact in a repo project", () => {
    const filed = design();
    filed.status = 'writing';
    filed.steps[0].status = 'current';
    filed.steps[0].evidence = {
      kind: 'repo',
      file: 'src/discharge.ts',
      coverage: { reading: 'unmeasured', atSha: null },
    };
    expect(refusalsAt(filed)).toEqual([]);
    expect(sourceRefusals(filed, storefront)).toEqual([
      'WORKFLOW_EVIDENCE_KIND_MISMATCH /steps/0/evidence',
    ]);
    expect(sourceRefusals(filed, { kind: 'repo' })).toEqual([]);

    const built = design();
    built.steps[0].evidence = {
      kind: 'storefront',
      provider: 'autoflow',
      ref: 'workflow',
      id: 'wf_1',
    };
    expect(sourceRefusals(built, storefront)).toEqual([]);
    expect(sourceRefusals(built, { kind: 'storefront', provider: 'epodsystem' })).toEqual([
      'WORKFLOW_EVIDENCE_KIND_MISMATCH /steps/0/evidence',
    ]);
    expect(sourceRefusals(built, { kind: 'repo' })).toEqual([
      'WORKFLOW_EVIDENCE_KIND_MISMATCH /steps/0/evidence',
    ]);
  });

  it('refuses a version-1 file evidence in a storefront project too', () => {
    const parsed = parseWorkflow({ ...release(), project: HOP }, HOP);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
    expect(evidenceSourceRefusals(parsed.value, storefront)[0]?.code).toBe(
      'WORKFLOW_EVIDENCE_KIND_MISMATCH',
    );
  });
});

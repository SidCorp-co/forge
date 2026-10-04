import { readFileSync } from 'node:fs';
import { BUILTIN_WORKFLOW_TEMPLATES } from '@forge/contracts/workflow-templates';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { workflowJsonSchemas } from './json-schema.js';
import {
  checkWorkflow,
  parseWorkflow,
  workflowIdentityRefusals,
  workflowWriterRefusal,
} from './rules.js';
import type { WorkflowWrite } from './schema.js';

const CTX = { templates: BUILTIN_WORKFLOW_TEMPLATES, designs: new Map() };

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
type Doc = Record<string, any>;

const HOP = '5e1d7c3a-2b4f-4a6e-9c8d-0f1e2a3b4c5d';
const OTHER = '8f4c3d6b-ae5a-4b1d-8243-5d6e7f8091a3';

const design = (): Doc =>
  JSON.parse(
    readFileSync(new URL('./fixtures/post-discharge.design.json', import.meta.url), 'utf8'),
  );

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const emittedV2 = ajv.compile(workflowJsonSchemas['workflow-v2.json'] as object);
const stamped = (d: Doc) => ({
  ...d,
  id: 'c17f6a9e-1d2b-4c3a-8e4f-5a6b7c8d9e01',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
});

const refusalsAt = (raw: Doc) => {
  const parsed = parseWorkflow(raw, HOP);
  return (parsed.ok ? checkWorkflow(parsed.value, CTX) : parsed.refusals).map(
    (r) => `${r.code} ${r.path}`,
  );
};

describe('a workflow-v2 design', () => {
  it('stands as the plan alone, and the emitted schema agrees', () => {
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
      'a step carrying the code reading, which is an observation now',
      (d: Doc) => (d.steps[0].evidence = null),
      'UNKNOWN_KEY /steps/0/evidence',
    ],
    ['a step status', (d: Doc) => (d.steps[0].status = 'current'), 'UNKNOWN_KEY /steps/0/status'],
    ['a document drift', (d: Doc) => (d.drift = null), 'UNKNOWN_KEY /drift'],
    ['another project', (d: Doc) => (d.project = OTHER), 'PROJECT_ID_IMMUTABLE /project'],
  ])('refuses %s by name', (_name, patch, expected) => {
    const d = design();
    patch(d);
    expect(refusalsAt(d)).toEqual([expected]);
  });

  it('refuses a version-1 document: that version carried the code reading inside the design', () => {
    expect(refusalsAt({ ...design(), version: 1 })).toEqual(['VERSION_UNSUPPORTED /version']);
  });
});

describe('who writes a workflow', () => {
  const at = (agency: 'agent' | 'human', role: 'viewer' | 'member' | 'admin' | null) =>
    workflowWriterRefusal({ userId: 'u', agency, role }, HOP)?.code ?? null;

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

describe('a rewritten workflow keeps what it is', () => {
  const stored = (): WorkflowWrite => {
    const p = parseWorkflow(design(), HOP);
    if (!p.ok) throw new Error('the fixture design does not parse');
    return p.value;
  };

  it('accepts new steps on the same flow', () => {
    expect(workflowIdentityRefusals(stored(), { ...stored(), title: 'Renamed' })).toEqual([]);
  });

  it('refuses a renamed flow or a changed kind by name', () => {
    const next: WorkflowWrite = { ...stored(), flow: 'shipping', kind: 'state' };
    expect(workflowIdentityRefusals(stored(), next).map((r) => `${r.code} ${r.path}`)).toEqual([
      'WORKFLOW_IDENTITY_IMMUTABLE /flow',
      'WORKFLOW_IDENTITY_IMMUTABLE /kind',
    ]);
  });
});

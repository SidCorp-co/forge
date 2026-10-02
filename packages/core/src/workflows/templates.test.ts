import { readFileSync } from 'node:fs';
import {
  BUILTIN_WORKFLOW_TEMPLATES,
  findTemplate,
  resolveProjectTemplates,
  templateConsistencyRefusals,
  templateLinkRefusals,
  type WorkflowTemplate,
  workflowTemplateSchema,
} from '@forge/contracts/workflow-templates';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_CHOICES,
  TEMPLATE_SKETCHES,
  WORKFLOW_TEMPLATES_GUIDE,
} from '../guides/workflow-templates-guide.js';
import { designFingerprint } from './design.js';
import { workflowJsonSchemas } from './json-schema.js';
import { checkWorkflow, parseWorkflow } from './rules.js';
import { readStoredWorkflow, type WorkflowWrite } from './schema.js';
import { type ProjectDesign, type ProjectDesigns, projectDesignOf } from './template-check.js';
import { TEMPLATE_EXAMPLES } from './template-examples.js';

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
type Doc = Record<string, any>;

const PROJECT = '00000000-0000-4000-8000-000000000000';
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const emittedTemplate = ajv.compile(workflowJsonSchemas['workflow-template-v1.json'] as object);
const emittedV2 = ajv.compile(workflowJsonSchemas['workflow-v2.json'] as object);

/** The examples are one project's designs; each is checked with the others as its project. */
const designsBesides = (flow: string): ProjectDesigns =>
  new Map(
    Object.values(TEMPLATE_EXAMPLES)
      .filter((d) => d.flow !== flow)
      .map((d) => [d.flow, projectDesignOf(d, BUILTIN_WORKFLOW_TEMPLATES)] as const)
      .filter((e): e is readonly [string, ProjectDesign] => e[1] !== null),
  );
const ctxFor = (d: Doc, templates: readonly WorkflowTemplate[] = BUILTIN_WORKFLOW_TEMPLATES) => ({
  templates,
  designs: designsBesides(d.flow),
});

const example = (key: string): Doc => structuredClone(TEMPLATE_EXAMPLES[key]) as Doc;
const refusalsOf = (raw: Doc, ctx = ctxFor(raw)) => {
  const parsed = parseWorkflow(raw, PROJECT);
  return (parsed.ok ? checkWorkflow(parsed.value, ctx) : parsed.refusals).map(
    (r) => `${r.code} ${r.path}`,
  );
};
const detailOf = (raw: Doc) => {
  const parsed = parseWorkflow(raw, PROJECT);
  const out = parsed.ok ? checkWorkflow(parsed.value, ctxFor(raw)) : parsed.refusals;
  return out.map((r) => r.detail).join(' | ');
};
const stamped = (d: Doc) => ({
  ...d,
  id: 'c17f6a9e-1d2b-4c3a-8e4f-5a6b7c8d9e01',
  createdAt: '2026-10-02T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
});

describe('the built-in diagram templates', () => {
  it('are each consistent, parse by their own meta-schema, and pass the emitted one', () => {
    for (const t of BUILTIN_WORKFLOW_TEMPLATES) {
      expect(templateConsistencyRefusals(t), t.id).toEqual([]);
      expect(workflowTemplateSchema.safeParse(t).success, t.id).toBe(true);
      expect(emittedTemplate(t), `${t.id}: ${JSON.stringify(emittedTemplate.errors)}`).toBe(true);
      expect(templateLinkRefusals(t, BUILTIN_WORKFLOW_TEMPLATES), t.id).toEqual([]);
    }
    expect(BUILTIN_WORKFLOW_TEMPLATES.map((t) => t.id)).toEqual([
      'operational-flow',
      'service-blueprint',
      'service-blueprint-cross-functional',
      'ux-flow',
      'state-machine',
      'state-machine-fhir-task',
      'state-machine-fhir-encounter',
      'integration-sequence',
      'decision-model',
      'data-flow',
      'system-context',
    ]);
  });

  it.each(BUILTIN_WORKFLOW_TEMPLATES.map((t) => `${t.id}@${t.version}`))(
    "%s's example design is accepted, and the emitted workflow-v2 schema agrees",
    (key) => {
      expect(refusalsOf(example(key))).toEqual([]);
      expect(emittedV2(stamped(example(key))), JSON.stringify(emittedV2.errors)).toBe(true);
    },
  );

  it('each has a sketch and a row in the choice table of the guide, which renders its vocabulary', () => {
    for (const t of BUILTIN_WORKFLOW_TEMPLATES) {
      expect(TEMPLATE_SKETCHES[t.id], t.id).toBeTruthy();
      expect(
        TEMPLATE_CHOICES.some(([, id]) => id === t.id),
        t.id,
      ).toBe(true);
      expect(WORKFLOW_TEMPLATES_GUIDE.body).toContain(`\`${t.id}@${t.version}\``);
      for (const n of t.nodeTypes)
        expect(WORKFLOW_TEMPLATES_GUIDE.body).toContain(`| \`${n.id}\` |`);
    }
    expect(
      TEMPLATE_CHOICES.map(([, id]) => id).every((id) =>
        findTemplate(BUILTIN_WORKFLOW_TEMPLATES, { id, version: 1 }),
      ),
    ).toBe(true);
  });
});

const contract = (from: string, to: string) => ({
  from,
  to,
  label: 'planted',
  payload: ['x'],
  onFailure: 'raise it',
});

describe('a design checked against its template', () => {
  const ops = () => example('operational-flow@1');

  it.each([
    ['no template', (d: Doc) => delete d.template, 'WORKFLOW_TEMPLATE_MISSING /template'],
    [
      'an unknown template',
      (d: Doc) => (d.template = { id: 'mind-map', version: 1 }),
      'WORKFLOW_TEMPLATE_UNKNOWN /template',
    ],
    [
      'a version the template does not have',
      (d: Doc) => (d.template.version = 7),
      'WORKFLOW_TEMPLATE_UNKNOWN /template',
    ],
    [
      'a node type the template does not declare',
      (d: Doc) => (d.steps[4].node.type = 'SCREEN'),
      'WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE /steps/4/node/type',
    ],
    [
      'a node in a band that does not admit its type',
      (d: Doc) => (d.steps[2].node.band = 'act'),
      'WORKFLOW_BAND_MISMATCH /steps/2/node/band',
    ],
    [
      'a node in no band of the template',
      (d: Doc) => (d.steps[2].node.band = 'nowhere'),
      'WORKFLOW_BAND_MISMATCH /steps/2/node/band',
    ],
    [
      'a RULE without its outputs',
      (d: Doc) => delete d.steps[3].node.outputs,
      'WORKFLOW_NODE_FIELD_MISSING /steps/3/node',
    ],
    [
      'a TASK with no idempotency',
      (d: Doc) => delete d.steps[5].node.idempotency,
      'WORKFLOW_NODE_FIELD_MISSING /steps/5/node',
    ],
    [
      'an OUTCOME with an empty set of values',
      (d: Doc) => (d.steps[7].node.values = []),
      'SCHEMA_VIOLATION /steps/7/node/values',
    ],
    [
      'an event not named domain.verb_past',
      (d: Doc) => (d.steps[1].node.event = 'Discharged'),
      'SCHEMA_VIOLATION /steps/1/node/event',
    ],
    [
      'an edge kind the template does not declare',
      (d: Doc) => (d.edges[0].kind = 'transition'),
      'WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE /edges/0/kind',
    ],
    [
      'a named kind that does not join its endpoint types',
      (d: Doc) => (d.edges[2].kind = 'evaluates'),
      'WORKFLOW_EDGE_ENDPOINT_NOT_IN_KIND /edges/2',
    ],
    [
      'a line with no onFailure',
      (d: Doc) => delete d.edges[3].onFailure,
      'WORKFLOW_EDGE_FIELD_MISSING /edges/3',
    ],
    [
      'a feeds-back with no idempotency',
      (d: Doc) => delete d.edges[7].idempotency,
      'WORKFLOW_EDGE_FIELD_MISSING /edges/7',
    ],
    [
      'an `after` line with no contract, where its kind owes one',
      (d: Doc) => d.edges.splice(4, 1),
      'WORKFLOW_EDGE_FIELD_MISSING /steps/5/after/0',
    ],
    [
      'a line no kind of the template joins',
      (d: Doc) => d.steps[7].after.push('discharged'),
      'WORKFLOW_EDGE_KIND_NONE /steps/7/after/1',
    ],
    [
      'a forward line that climbs the bands',
      (d: Doc) => (d.steps[2].node.band = 'feedback'),
      'WORKFLOW_TEMPLATE_RULE /steps/3/after/1',
    ],
    [
      'a step that starts the flow and is no entry type',
      (d: Doc) =>
        d.steps.push({
          ...d.steps[4],
          id: 'late',
          after: [],
          node: { type: 'ATTENTION', label: 'Late' },
        }),
      'WORKFLOW_NODE_NOT_ENTRY /steps/8/after',
    ],
    [
      'an event two sources emit',
      (d: Doc) => {
        d.steps.unshift({
          ...d.steps[0],
          id: 'lis',
          node: { type: 'SOURCE', label: 'LIS', owner: 'lab' },
        });
        d.steps[2].after.push('lis');
        d.edges.push(contract('lis', 'discharged'));
      },
      'WORKFLOW_NODE_LINES /steps/2',
    ],
    [
      'an outcome that does not feed back',
      (d: Doc) => d.edges.pop(),
      'WORKFLOW_NODE_LINES /steps/7',
    ],
  ])('operational-flow refuses %s by name', (_name, patch, expected) => {
    const d = ops();
    patch(d);
    expect(refusalsOf(d)).toEqual([expected]);
  });

  it('names the fix in the refusal: the fields owed, the bands that admit the type, the kinds a type may take', () => {
    const missing = ops();
    delete missing.steps[3].node.outputs;
    expect(detailOf(missing)).toContain(
      'requires a RULE to carry label, inputs, conditions, outputs',
    );
    const banded = ops();
    banded.steps[2].node.band = 'act';
    expect(detailOf(banded)).toContain('a CONTEXT sits in understand or feedback');
    const joined = ops();
    joined.steps[7].after.push('discharged');
    expect(detailOf(joined)).toContain(
      'no line of template operational-flow@1 joins a EVENT to a OUTCOME',
    );
    const lines = ops();
    lines.edges.pop();
    expect(detailOf(lines)).toContain('has 0 outgoing feeds-back lines');
  });

  it('reads the kind of a line that names none from its endpoints, and refuses one that could be two', () => {
    const d = example('system-context@1');
    delete d.edges[1].kind;
    expect(refusalsOf(d)).toEqual(['WORKFLOW_EDGE_KIND_AMBIGUOUS /edges/1']);
    expect(detailOf(d)).toContain('could be reads-from or writes-to');
  });

  it('refuses design lanes that a design-laned template is not given, and lanes on one that draws its own', () => {
    const noLanes = example('system-context@1');
    delete noLanes.lanes;
    expect(refusalsOf(noLanes)).toEqual(['WORKFLOW_BAND_MISMATCH /lanes']);
    const foreign = example('system-context@1');
    foreign.steps[2].node.band = 'finance';
    expect(refusalsOf(foreign)).toEqual(['WORKFLOW_BAND_MISMATCH /steps/2/node/band']);
    const extra = ops();
    extra.lanes = [{ id: 'a', label: 'A' }];
    expect(refusalsOf(extra)).toEqual(['WORKFLOW_BAND_MISMATCH /lanes']);
    const unbanded = example('state-machine@1');
    unbanded.steps[1].node.band = 'decide';
    expect(refusalsOf(unbanded)).toEqual(['WORKFLOW_BAND_MISMATCH /steps/1/node/band']);
  });
});

describe('a state-machine design', () => {
  it.each([
    [
      'state-machine@1',
      'a second initial state',
      (d: Doc) => {
        d.steps.push({ ...d.steps[0], id: 'start2' });
        d.steps[1].after.push('start2');
        d.edges.push({ from: 'start2', to: 'open', label: 'case.imported' });
      },
      'WORKFLOW_NODE_TYPE_COUNT /steps',
    ],
    [
      'state-machine@1',
      'a state with no way out',
      (d: Doc) => {
        d.steps.push({ ...d.steps[1], id: 'parked', after: ['open'] });
        d.edges.push({ from: 'open', to: 'parked', label: 'case.parked' });
      },
      'WORKFLOW_NODE_LINES /steps/4',
    ],
    [
      'state-machine@1',
      'a line out of a final state',
      (d: Doc) => d.edges.push({ kind: 'back', from: 'closed', to: 'open', label: 'reopened' }),
      'WORKFLOW_EDGE_ENDPOINT_NOT_IN_KIND /edges/4',
    ],
    [
      'state-machine@1',
      'a reopen drawn forward in `after`',
      (d: Doc) => (d.steps[1].after = ['start', 'working']),
      'WORKFLOW_AFTER_CYCLE /steps/1/after',
    ],
    [
      'state-machine@1',
      'a back edge that goes forward',
      (d: Doc) => Object.assign(d.edges[3], { from: 'start', to: 'working' }),
      'WORKFLOW_EDGE_RETURN_FORWARD /edges/3/kind',
    ],
    [
      'state-machine-fhir-task@1',
      'a state mapped to no FHIR Task status',
      (d: Doc) => (d.steps[1].node.mapsTo = 'open'),
      'WORKFLOW_NODE_VALUE_NOT_IN_VOCABULARY /steps/1/node/mapsTo',
    ],
    [
      'state-machine-fhir-encounter@1',
      'a state that names no Encounter status',
      (d: Doc) => delete d.steps[2].node.mapsTo,
      'WORKFLOW_NODE_FIELD_MISSING /steps/2/node',
    ],
  ])('%s refuses %s by name', (key, _name, patch, expected) => {
    const d = example(key);
    patch(d);
    expect(refusalsOf(d)).toEqual([expected]);
  });
});

describe('a design written before templates', () => {
  const legacy = (): Doc => {
    const d = JSON.parse(
      readFileSync(new URL('./fixtures/post-discharge.design.json', import.meta.url), 'utf8'),
    );
    delete d.template;
    return d;
  };
  const operational = findTemplate(BUILTIN_WORKFLOW_TEMPLATES, {
    id: 'operational-flow',
    version: 1,
  });

  it('is read back as operational-flow@1, and a write of it still owes its template', () => {
    expect(
      (readStoredWorkflow(legacy()) as Extract<WorkflowWrite, { version: 2 }>).template,
    ).toEqual({ id: 'operational-flow', version: 1 });
    const parsed = parseWorkflow(legacy(), legacy().project);
    expect(parsed.ok ? [] : parsed.refusals.map((r) => `${r.code} ${r.path}`)).toEqual([
      'WORKFLOW_TEMPLATE_MISSING /template',
    ]);
  });

  it('keeps the fingerprint it was approved at when the default template, the implied kind and the home band are spelled out', () => {
    const stored = readStoredWorkflow(legacy());
    if (!stored) throw new Error('legacy fixture did not read');
    const base = designFingerprint(stored, operational);
    const spelled = legacy();
    spelled.template = { id: 'operational-flow', version: 1 };
    spelled.edges[0].kind = 'emits';
    spelled.steps[2].node.band = 'understand';
    const parsed = parseWorkflow(spelled, spelled.project);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
    expect(designFingerprint(parsed.value, operational)).toBe(base);
    const moved = structuredClone(spelled);
    moved.steps[2].node.band = 'feedback';
    const movedParsed = parseWorkflow(moved, moved.project);
    if (!movedParsed.ok) throw new Error('moved did not parse');
    expect(designFingerprint(movedParsed.value, operational)).not.toBe(base);
  });

  it('changing the template is a design change', () => {
    const d = example('service-blueprint-cross-functional@1');
    const parsed = parseWorkflow(d, PROJECT);
    if (!parsed.ok) throw new Error('example did not parse');
    const resolved = resolveProjectTemplates([
      {
        $schema: 'https://forge.sidcorp.co/schemas/workflow-template-v1.json',
        id: 'roles-plus',
        version: 1,
        title: 'Roles plus',
        purpose: 'Use when testing.',
        extends: { id: 'service-blueprint-cross-functional', version: 1 },
      },
    ]);
    expect(resolved.refusals).toEqual([]);
    const moved = { ...parsed.value, template: { id: 'roles-plus', version: 1 } } as WorkflowWrite;
    expect(refusalsOf(moved as Doc, ctxFor(moved as Doc, resolved.templates))).toEqual([]);
    const roles = findTemplate(resolved.templates, { id: 'roles-plus', version: 1 });
    expect(designFingerprint(moved, roles)).not.toBe(
      designFingerprint(
        parsed.value,
        findTemplate(BUILTIN_WORKFLOW_TEMPLATES, {
          id: 'service-blueprint-cross-functional',
          version: 1,
        }),
      ),
    );
  });
});

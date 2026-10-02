import { readFileSync } from 'node:fs';
import {
  BUILTIN_WORKFLOW_TEMPLATES,
  findTemplate,
  resolveProjectTemplates,
  templateConsistencyRefusals,
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
import { TEMPLATE_EXAMPLES } from './template-examples.js';

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
type Doc = Record<string, any>;

const PROJECT = '00000000-0000-4000-8000-000000000000';
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const emittedTemplate = ajv.compile(workflowJsonSchemas['workflow-template-v1.json'] as object);
const emittedV2 = ajv.compile(workflowJsonSchemas['workflow-v2.json'] as object);

/** The designs the ux-flow example points at: the journey example's steps. */
const DESIGNS = new Map([
  ['post-discharge', (TEMPLATE_EXAMPLES['journey-bands@1']?.steps ?? []).map((s) => s.id)],
]);
const CTX = { templates: BUILTIN_WORKFLOW_TEMPLATES, designs: DESIGNS };

const example = (key: string): Doc => structuredClone(TEMPLATE_EXAMPLES[key]) as Doc;
const refusalsOf = (raw: Doc, ctx = CTX) => {
  const parsed = parseWorkflow(raw, PROJECT);
  return (parsed.ok ? checkWorkflow(parsed.value, ctx) : parsed.refusals).map(
    (r) => `${r.code} ${r.path}`,
  );
};
const detailOf = (raw: Doc) => {
  const parsed = parseWorkflow(raw, PROJECT);
  const out = parsed.ok ? checkWorkflow(parsed.value, CTX) : parsed.refusals;
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
    }
    expect(BUILTIN_WORKFLOW_TEMPLATES.map((t) => t.id)).toEqual([
      'journey-bands',
      'state-machine',
      'process-swimlanes',
      'integration-sequence',
      'decision-tree',
      'data-lineage',
      'ux-flow',
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

describe('a design checked against its template', () => {
  const journey = () => example('journey-bands@1');

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
      (d: Doc) => (d.steps[1].node.type = 'SCREEN'),
      'WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE /steps/1/node/type',
    ],
    [
      'a node in a band that does not admit its type',
      (d: Doc) => (d.steps[1].node.band = 'act'),
      'WORKFLOW_BAND_MISMATCH /steps/1/node/band',
    ],
    [
      'a node in no band of the template',
      (d: Doc) => (d.steps[1].node.band = 'nowhere'),
      'WORKFLOW_BAND_MISMATCH /steps/1/node/band',
    ],
    [
      'a RULE without its tests',
      (d: Doc) => delete d.steps[2].node.tests,
      'WORKFLOW_NODE_FIELD_MISSING /steps/2/node',
    ],
    [
      'a TASK with an empty permission list',
      (d: Doc) => (d.steps[3].node.permissions = []),
      'WORKFLOW_NODE_FIELD_MISSING /steps/3/node',
    ],
    [
      'an edge kind the template does not declare',
      (d: Doc) => (d.edges[0].kind = 'transition'),
      'WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE /edges/0/kind',
    ],
    [
      'an escalation with no condition',
      (d: Doc) => delete d.edges[0].condition,
      'WORKFLOW_EDGE_FIELD_MISSING /edges/0',
    ],
    [
      'a feedback edge without its idempotency',
      (d: Doc) => delete d.edges[1].idempotency,
      'WORKFLOW_EDGE_FIELD_MISSING /edges/1',
    ],
    [
      'a forward line that climbs the bands',
      (d: Doc) => (d.steps[5].node = { type: 'STEP', band: 'trigger' }),
      'WORKFLOW_TEMPLATE_RULE /steps/5/after/0',
    ],
  ])('refuses %s by name', (_name, patch, expected) => {
    const d = journey();
    patch(d);
    expect(refusalsOf(d)).toEqual([expected]);
  });

  it('names the fix in the refusal: the fields owed, the bands that admit the type, the kinds declared', () => {
    const missing = journey();
    delete missing.steps[2].node.tests;
    expect(detailOf(missing)).toContain(
      'requires a RULE to carry inputs, conditions, outputs, tests',
    );
    const banded = journey();
    banded.steps[1].node.band = 'act';
    expect(detailOf(banded)).toContain('a CONTEXT sits in understand or feedback');
    const kinded = journey();
    kinded.edges[0].kind = 'transition';
    expect(detailOf(kinded)).toContain('flow (forward), escalation (forward), feedback (return)');
  });

  it('refuses an implicit `after` line whose default kind owes fields, at the line', () => {
    const d = example('data-lineage@1');
    d.edges.pop();
    expect(refusalsOf(d)).toEqual(['WORKFLOW_EDGE_FIELD_MISSING /steps/3/after/0']);
  });

  it('refuses design lanes that a design-laned template is not given, and lanes on one that draws its own', () => {
    const noLanes = example('process-swimlanes@1');
    delete noLanes.lanes;
    expect(refusalsOf(noLanes)).toEqual(['WORKFLOW_BAND_MISMATCH /lanes']);
    const foreign = example('process-swimlanes@1');
    foreign.steps[2].node.band = 'finance';
    expect(refusalsOf(foreign)).toEqual(['WORKFLOW_BAND_MISMATCH /steps/2/node/band']);
    const extra = journey();
    extra.lanes = [{ id: 'a', label: 'A' }];
    expect(refusalsOf(extra)).toEqual(['WORKFLOW_BAND_MISMATCH /lanes']);
    const unbanded = example('state-machine@1');
    unbanded.steps[1].node.band = 'decide';
    expect(refusalsOf(unbanded)).toEqual(['WORKFLOW_BAND_MISMATCH /steps/1/node/band']);
  });

  it.each([
    [
      'state-machine@1',
      'two initial states',
      (d: Doc) => (d.steps[1].node.initial = true),
      'WORKFLOW_TEMPLATE_RULE /steps',
    ],
    [
      'state-machine@1',
      'no terminal state',
      (d: Doc) => delete d.steps[3].node.terminal,
      'WORKFLOW_TEMPLATE_RULE /steps',
    ],
    [
      'state-machine@1',
      'a state after a terminal one',
      (d: Doc) => (d.steps[2].node.terminal = true),
      'WORKFLOW_TEMPLATE_RULE /steps/3/after/0',
    ],
    [
      'state-machine@1',
      'a reopen drawn forward in `after`',
      (d: Doc) => (d.steps[0].after = ['shipped']),
      'WORKFLOW_AFTER_CYCLE /steps/0/after',
    ],
    [
      'decision-tree@1',
      'a node with two parents',
      (d: Doc) =>
        d.steps[2].after.push('urgency') &&
        d.edges.push({ from: 'urgency', to: 'no-call', condition: 'x' }),
      'WORKFLOW_TEMPLATE_RULE /steps/2/after',
    ],
    [
      'process-swimlanes@1',
      'a second entry',
      (d: Doc) => (d.steps[2].after = []),
      'WORKFLOW_TEMPLATE_RULE /steps',
    ],
    [
      'state-machine@1',
      'a back edge that goes forward',
      (d: Doc) => Object.assign(d.edges[3], { from: 'placed', to: 'delivered' }),
      'WORKFLOW_EDGE_RETURN_FORWARD /edges/3/kind',
    ],
  ])('%s refuses %s by name', (key, _name, patch, expected) => {
    const d = example(key);
    patch(d);
    expect(refusalsOf(d)).toEqual([expected]);
  });
});

describe('a ux-flow design', () => {
  const ux = () => example('ux-flow@1');

  it.each([
    [
      'a screen with no error state and no reason',
      (d: Doc) => delete d.steps[4].node.noErrorState,
      'WORKFLOW_TEMPLATE_RULE /steps/4/node',
    ],
    [
      'a submit missing its failure target',
      (d: Doc) => delete d.edges[1].failure,
      'WORKFLOW_EDGE_FIELD_MISSING /edges/1',
    ],
    [
      'a submit whose success is no step',
      (d: Doc) => (d.edges[1].success = 'thanks'),
      'WORKFLOW_TEMPLATE_RULE /edges/1/success',
    ],
    [
      'an invokes naming a design the project does not hold',
      (d: Doc) => (d.steps[3].node.invokes.workflow = 'billing'),
      'WORKFLOW_TEMPLATE_RULE /steps/3/node/invokes',
    ],
    [
      'an invokes naming a step the design does not have',
      (d: Doc) => (d.steps[3].node.invokes.step = 'collect'),
      'WORKFLOW_TEMPLATE_RULE /steps/3/node/invokes',
    ],
    [
      'an invokes naming its own design',
      (d: Doc) => (d.steps[3].node.invokes = { workflow: 'book-follow-up-ui', step: 'patient' }),
      'WORKFLOW_TEMPLATE_RULE /steps/3/node/invokes',
    ],
    [
      'a persona the design does not declare',
      (d: Doc) => (d.steps[0].node.persona = 'patient'),
      'WORKFLOW_TEMPLATE_RULE /steps/0/node/persona',
    ],
    [
      'a system step with no invokes',
      (d: Doc) => delete d.steps[3].node.invokes,
      'WORKFLOW_NODE_FIELD_MISSING /steps/3/node',
    ],
    [
      'a screen with no persona',
      (d: Doc) => delete d.steps[0].node.persona,
      'WORKFLOW_NODE_FIELD_MISSING /steps/0/node',
    ],
    [
      'an action with no validation',
      (d: Doc) => delete d.steps[2].node.validation,
      'WORKFLOW_NODE_FIELD_MISSING /steps/2/node',
    ],

    [
      'a submit from a screen',
      (d: Doc) =>
        d.steps[3].after.push('patient') &&
        d.edges.push({
          kind: 'submit',
          from: 'patient',
          to: 'book',
          payload: ['x'],
          success: 'booked',
          failure: 'slot-taken',
        }),
      'WORKFLOW_EDGE_ENDPOINT_NOT_IN_KIND /edges/3',
    ],
    [
      'an implicit navigate into a system step',
      (d: Doc) => d.steps[3].after.push('patient'),
      'WORKFLOW_EDGE_ENDPOINT_NOT_IN_KIND /steps/3/after/1',
    ],
  ])('refuses %s by name', (_name, patch, expected) => {
    const d = ux();
    patch(d);
    expect(refusalsOf(d)).toEqual([expected]);
  });

  it('refuses a navigate line into a UI state, and the screen it leaves then has no error state', () => {
    const d = ux();
    d.edges[0].kind = 'navigate';
    expect(refusalsOf(d)).toEqual([
      'WORKFLOW_EDGE_ENDPOINT_NOT_IN_KIND /edges/0',
      'WORKFLOW_TEMPLATE_RULE /steps/0/node',
    ]);
    expect(detailOf(d)).toContain('A line that may reach a UI_STATE is error');
  });

  it('takes `back` as a return that is never part of the cycle check', () => {
    const d = ux();
    d.edges.push({ kind: 'back', from: 'booked', to: 'patient' });
    expect(refusalsOf(d)).toEqual([]);
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

  it('is read back as journey-bands@1, and a write of it still owes its template', () => {
    expect(
      (readStoredWorkflow(legacy()) as Extract<WorkflowWrite, { version: 2 }>).template,
    ).toEqual({
      id: 'journey-bands',
      version: 1,
    });
    const parsed = parseWorkflow(legacy(), legacy().project);
    expect(parsed.ok ? [] : parsed.refusals.map((r) => `${r.code} ${r.path}`)).toEqual([
      'WORKFLOW_TEMPLATE_MISSING /template',
    ]);
  });

  it('keeps the fingerprint it was approved at when the default template, kind and band are spelled out', () => {
    const journey = findTemplate(BUILTIN_WORKFLOW_TEMPLATES, { id: 'journey-bands', version: 1 });
    const stored = readStoredWorkflow(legacy());
    if (!stored) throw new Error('legacy fixture did not read');
    const base = designFingerprint(stored, journey);
    const spelled = legacy();
    spelled.template = { id: 'journey-bands', version: 1 };
    spelled.edges[0].kind = 'flow';
    spelled.steps[1].node.band = 'understand';
    const parsed = parseWorkflow(spelled, spelled.project);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
    expect(designFingerprint(parsed.value, journey)).toBe(base);
    const moved = structuredClone(spelled);
    moved.steps[1].node.band = 'feedback';
    const movedParsed = parseWorkflow(moved, moved.project);
    if (!movedParsed.ok) throw new Error('moved did not parse');
    expect(designFingerprint(movedParsed.value, journey)).not.toBe(base);
  });

  it('changing the template is a design change', () => {
    const d = example('process-swimlanes@1');
    const parsed = parseWorkflow(d, PROJECT);
    if (!parsed.ok) throw new Error('example did not parse');
    const resolved = resolveProjectTemplates([
      {
        $schema: 'https://forge.sidcorp.co/schemas/workflow-template-v1.json',
        id: 'lanes-plus',
        version: 1,
        title: 'Lanes plus',
        purpose: 'Use when testing.',
        extends: { id: 'process-swimlanes', version: 1 },
      },
    ]);
    expect(resolved.refusals).toEqual([]);
    const moved = { ...parsed.value, template: { id: 'lanes-plus', version: 1 } } as WorkflowWrite;
    expect(refusalsOf(moved as Doc, { templates: resolved.templates, designs: DESIGNS })).toEqual(
      [],
    );
    const lanes = findTemplate(resolved.templates, { id: 'lanes-plus', version: 1 });
    expect(designFingerprint(moved, lanes)).not.toBe(
      designFingerprint(
        parsed.value,
        findTemplate(BUILTIN_WORKFLOW_TEMPLATES, { id: 'process-swimlanes', version: 1 }),
      ),
    );
  });
});

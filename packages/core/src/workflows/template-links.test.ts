import {
  BUILTIN_WORKFLOW_TEMPLATES,
  lineKindOf,
  resolveProjectTemplates,
  templateConsistencyRefusals,
  type WorkflowTemplate,
} from '@forge/contracts/workflow-templates';
import { describe, expect, it } from 'vitest';
import { checkWorkflow, parseWorkflow } from './rules.js';
import { type ProjectDesign, projectDesignOf } from './template-check.js';
import { TEMPLATE_EXAMPLES } from './template-examples.js';

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
type Doc = Record<string, any>;

const PROJECT = '00000000-0000-4000-8000-000000000000';

const example = (key: string): Doc => structuredClone(TEMPLATE_EXAMPLES[key]) as Doc;

/** The examples as one project, `doc` standing in for the design of its own flow. */
const projectOf = (doc: Doc) =>
  new Map(
    Object.values(TEMPLATE_EXAMPLES)
      .filter((d) => d.flow !== doc.flow)
      .map((d) => [d.flow, projectDesignOf(d, BUILTIN_WORKFLOW_TEMPLATES)] as const)
      .filter((e): e is readonly [string, ProjectDesign] => e[1] !== null),
  );

const check = (raw: Doc, templates: readonly WorkflowTemplate[] = BUILTIN_WORKFLOW_TEMPLATES) => {
  const parsed = parseWorkflow(raw, PROJECT);
  return parsed.ok
    ? checkWorkflow(parsed.value, { templates, designs: projectOf(raw) })
    : parsed.refusals;
};
const refusalsOf = (raw: Doc) => check(raw).map((r) => `${r.code} ${r.path}`);
const detailOf = (raw: Doc) =>
  check(raw)
    .map((r) => r.detail)
    .join(' | ');

const ref = (template: string, flow: string, step: string) => ({ template, flow, step });

describe('a ux-flow design', () => {
  const ux = () => example('ux-flow@1');

  it.each([
    [
      'a screen that shows data with no error state',
      (d: Doc) => d.steps.splice(4, 1),
      'WORKFLOW_TEMPLATE_RULE /steps/1',
    ],
    [
      'two screens on one route',
      (d: Doc) => (d.steps[7].node.route = '/book'),
      'WORKFLOW_NODE_FIELD_NOT_UNIQUE /steps/7/node/route',
    ],
    ['no exit', (d: Doc) => d.steps.pop(), 'WORKFLOW_NODE_TYPE_COUNT /steps'],
    [
      'a screen with no wireframe',
      (d: Doc) => delete d.steps[1].node.wireframe,
      'WORKFLOW_NODE_FIELD_MISSING /steps/1/node',
    ],
    [
      'a route that is not a path',
      (d: Doc) => (d.steps[1].node.route = 'book'),
      'SCHEMA_VIOLATION /steps/1/node/route',
    ],
    [
      'a persona the design does not declare',
      (d: Doc) => (d.steps[1].node.persona = 'nurse'),
      'WORKFLOW_TEMPLATE_RULE /steps/1/node/persona',
    ],
    [
      'a state variant outside the list',
      (d: Doc) => (d.steps[2].node.variant = 'permission-denied'),
      'SCHEMA_VIOLATION /steps/2/node/variant',
    ],
    [
      'a navigate into a UI state',
      (d: Doc) => (d.edges = [{ kind: 'navigates', from: 'slots', to: 'slots-error' }]),
      'WORKFLOW_EDGE_ENDPOINT_NOT_IN_KIND /edges/0',
    ],
  ])('refuses %s by name', (_name, patch, expected) => {
    const d = ux();
    patch(d);
    expect(refusalsOf(d)).toEqual([expected]);
  });

  it('refuses a dead-end action, and the step it no longer reaches then starts the flow', () => {
    const d = ux();
    d.steps[6].after = [];
    expect(refusalsOf(d)).toEqual([
      'WORKFLOW_NODE_NOT_ENTRY /steps/6/after',
      'WORKFLOW_NODE_LINES /steps/5',
    ]);
    expect(detailOf(d)).toContain('USER_ACTION step "pick" has 0 outgoing lines');
  });

  it('names the states a data screen is missing', () => {
    const d = ux();
    d.steps.splice(2, 2);
    expect(detailOf(d)).toContain('draws no empty, loading state');
  });

  it('takes `back` as a return that is never part of the cycle check', () => {
    const d = ux();
    d.edges = [{ kind: 'back', from: 'booked', to: 'slots' }];
    expect(refusalsOf(d)).toEqual([]);
  });

  it('reads each line of the example by its endpoints', () => {
    const t = BUILTIN_WORKFLOW_TEMPLATES.find((x) => x.id === 'ux-flow') as WorkflowTemplate;
    expect(
      (
        [
          ['ENTRY', 'SCREEN'],
          ['SCREEN', 'UI_STATE'],
          ['SCREEN', 'USER_ACTION'],
          ['SYSTEM', 'SCREEN'],
          ['USER_ACTION', 'SCREEN'],
        ] as const
      ).map(([a, b]) => lineKindOf(t, a, b)),
    ).toEqual([
      { kind: 'navigates' },
      { kind: 'shows' },
      { kind: 'flow' },
      { kind: 'returns' },
      { kind: 'navigates' },
    ]);
  });
});

describe('a cross-link between designs', () => {
  const ux = () => example('ux-flow@1');

  it.each([
    [
      'a ref to a template its type does not link to',
      (d: Doc) => d.steps[5].node.refs.push(ref('decision-model', 'followup-decision', 'followup')),
      'WORKFLOW_REF_NOT_ALLOWED /steps/5/node/refs/2',
    ],
    [
      'a ref to a design the project does not hold',
      (d: Doc) => (d.steps[5].node.refs[0].flow = 'billing'),
      'WORKFLOW_REF_DANGLING /steps/5/node/refs/0',
    ],
    [
      'a ref to a step the design does not have',
      (d: Doc) => (d.steps[5].node.refs[0].step = 'collect'),
      'WORKFLOW_REF_DANGLING /steps/5/node/refs/0',
    ],
    [
      'a ref to a step of a type the link does not take',
      (d: Doc) => (d.steps[5].node.refs[0].step = 'case'),
      'WORKFLOW_REF_TARGET_MISMATCH /steps/5/node/refs/0',
    ],
    [
      'a ref to a design drawn in another template',
      (d: Doc) =>
        (d.steps[5].node.refs[0] = ref('operational-flow', 'followup-decision', 'followup')),
      'WORKFLOW_REF_TARGET_MISMATCH /steps/5/node/refs/0',
    ],
    [
      'a ref to its own design',
      (d: Doc) => (d.steps[5].node.refs[0] = ref('operational-flow', 'book-followup', 'slots')),
      'WORKFLOW_REF_DANGLING /steps/5/node/refs/0',
    ],
  ])('refuses %s by name', (_name, patch, expected) => {
    const d = ux();
    patch(d);
    expect(refusalsOf(d)).toEqual([expected]);
  });

  it('refuses a type that must link and does not', () => {
    const d = example('integration-sequence@1');
    delete d.steps[0].node.refs;
    expect(refusalsOf(d)).toEqual(['WORKFLOW_REF_MISSING /steps/0/node']);
    expect(detailOf(d)).toContain('carries no ref to system-context');
  });

  it('refuses a write that removes a step other designs link to, naming each', () => {
    const d = example('system-context@1');
    d.steps.splice(2, 1);
    d.edges.splice(1, 1);
    const out = check(d);
    expect(out.map((r) => r.code)).toEqual([
      'WORKFLOW_REF_DANGLING',
      'WORKFLOW_REF_DANGLING',
      'WORKFLOW_REF_DANGLING',
    ]);
    expect(out.map((r) => r.detail.split(' step ')[0]).sort()).toEqual([
      'design "discharge-data"',
      'design "followup-blueprint"',
      'design "his-discharge-feed"',
    ]);
  });

  it('refuses a write that retypes a step another design links to', () => {
    const d = example('system-context@1');
    d.steps[2].node = { type: 'CONTAINER', band: 'hospital', label: 'HIS', purpose: 'records' };
    d.edges[1].kind = 'uses';
    expect(refusalsOf(d)).toEqual(['WORKFLOW_REF_TARGET_MISMATCH /steps/2']);
    expect(detailOf(d)).toContain(
      'design "discharge-data" step "his" links to hop-context/his as a SYSTEM',
    );
  });

  it('lets a link reach a design drawn in a preset of the template it names', () => {
    const d = example('operational-flow@1');
    d.steps.push({
      id: 'followup-state',
      does: 'The task is in progress.',
      after: ['followup-rule'],
      node: {
        type: 'STATE',
        label: 'In progress',
        refs: [ref('state-machine', 'task-lifecycle', 'working')],
      },
    });
    d.edges.push({
      from: 'followup-rule',
      to: 'followup-state',
      label: 'sets',
      payload: ['x'],
      onFailure: 'hold',
    });
    expect(refusalsOf(d)).toEqual([]);
  });
});

describe("a project template's links and presets", () => {
  const own = (patch: (t: Doc) => void) => {
    const t: Doc = structuredClone({
      ...BUILTIN_WORKFLOW_TEMPLATES.find((x) => x.id === 'decision-model'),
      id: 'triage-model',
    });
    patch(t);
    return resolveProjectTemplates([t as WorkflowTemplate]).refusals.map(
      (r) => `${r.code} ${r.path}`,
    );
  };

  it.each([
    [
      'a link to no template',
      (t: Doc) => (t.nodeTypes[1].links[0].template = 'patient-chart'),
      'WORKFLOW_TEMPLATE_INVALID /workflows/templates/0/nodeTypes/1/links/0/template',
    ],
    [
      'a link to a type its template does not declare',
      (t: Doc) => (t.nodeTypes[1].links[0].types = ['SCREEN']),
      'WORKFLOW_TEMPLATE_INVALID /workflows/templates/0/nodeTypes/1/links/0/types/0',
    ],
    [
      'a preset of no template',
      (t: Doc) => (t.presetOf = 'decision-tree'),
      'WORKFLOW_TEMPLATE_INVALID /workflows/templates/0/presetOf',
    ],
    [
      'a line count of a kind it does not declare',
      (t: Doc) => (t.nodeTypes[0].lines = { in: [{ kind: 'feeds', min: 1 }] }),
      'WORKFLOW_TEMPLATE_INVALID /workflows/templates/0/nodeTypes/0/lines/in/0/kind',
    ],
    [
      'a vocabulary on a field it does not require',
      (t: Doc) => (t.nodeTypes[0].vocabulary = ['yes', 'no']),
      'WORKFLOW_TEMPLATE_INVALID /workflows/templates/0/nodeTypes/0/vocabulary',
    ],
  ])('refuses %s by name', (_name, patch, expected) => {
    expect(own(patch)).toEqual([expected]);
  });

  it('refuses screen-states on a template with no shows kind', () => {
    const t = structuredClone(
      BUILTIN_WORKFLOW_TEMPLATES.find((x) => x.id === 'ux-flow'),
    ) as WorkflowTemplate;
    t.edgeKinds = t.edgeKinds.filter((k) => k.id !== 'shows');
    expect(templateConsistencyRefusals(t).map((r) => r.detail)).toEqual([
      'template ux-flow@1: rule screen-states reads SCREEN, UI_STATE, shows, and this template declares no shows.',
    ]);
  });
});

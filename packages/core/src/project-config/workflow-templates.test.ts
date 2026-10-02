import { describe, expect, it } from 'vitest';
import {
  type ConfigRefusal,
  checkWorkflowTemplates,
  type ProjectConfigContext,
  WORKFLOW_TEMPLATE_CONFIG_CODES,
} from './rules.js';
import { type ProjectDocument, projectDocumentSchema } from './schema.js';

const seen = new Set<string>();

function refusals(
  doc: Pick<ProjectDocument, 'workflows'>,
  ctx: Pick<ProjectConfigContext, 'workflowTemplatesInUse'>,
): ConfigRefusal[] {
  const out = checkWorkflowTemplates(doc, ctx);
  for (const r of out) seen.add(r.code);
  return out;
}

const pick = (out: ConfigRefusal[]) => out.map(({ code, path }) => ({ code, path }));

describe('a project diagram template (workflows.templates)', () => {
  const SCHEMA = 'https://forge.sidcorp.co/schemas/workflow-template-v1.json';
  // cm:why a care project that also tracks a referral as its own node type, added to the journey's Organise band
  const referral = () => ({
    $schema: SCHEMA,
    id: 'care-journey',
    version: 1,
    title: 'Care journey with referrals',
    purpose: 'Use when a care journey also refers patients out.',
    extends: { id: 'journey-bands', version: 1 },
    nodeTypes: [
      {
        id: 'REFERRAL',
        label: 'Referral',
        tooltip: 'A referral to another provider.',
        icon: 'send',
        colour: 'indigo',
        required: ['owner'],
        band: 'organise',
      },
    ],
    bandTypes: { organise: ['REFERRAL'] },
  });
  const withTemplates = (...templates: unknown[]) =>
    refusals({ workflows: projectDocumentSchema.shape.workflows.parse({ templates }) }, {});

  it('accepts an extension of a built-in that only adds', () => {
    expect(withTemplates(referral())).toEqual([]);
  });

  it('WORKFLOW_TEMPLATE_EXTENSION_OVERRIDES when an extension re-declares a base node type', () => {
    const t = referral();
    const [first] = t.nodeTypes;
    if (!first) throw new Error('referral has no node type');
    t.nodeTypes.push({ ...first, id: 'TASK' });
    expect(pick(withTemplates(t))).toEqual([
      {
        code: 'WORKFLOW_TEMPLATE_EXTENSION_OVERRIDES',
        path: '/workflows/templates/0/nodeTypes/1/id',
      },
    ]);
  });

  it('WORKFLOW_TEMPLATE_ID_TAKEN when a project template takes a built-in id', () => {
    expect(pick(withTemplates({ ...referral(), id: 'journey-bands' }))).toEqual([
      { code: 'WORKFLOW_TEMPLATE_ID_TAKEN', path: '/workflows/templates/0/id' },
    ]);
  });

  it('WORKFLOW_TEMPLATE_DUPLICATE when one id@version is declared twice', () => {
    expect(pick(withTemplates(referral(), referral()))).toEqual([
      { code: 'WORKFLOW_TEMPLATE_DUPLICATE', path: '/workflows/templates/1/version' },
    ]);
  });

  it('WORKFLOW_TEMPLATE_UNKNOWN when an extension extends nothing declared', () => {
    expect(
      pick(withTemplates({ ...referral(), extends: { id: 'journey-bands', version: 9 } })),
    ).toEqual([{ code: 'WORKFLOW_TEMPLATE_UNKNOWN', path: '/workflows/templates/0/extends' }]);
  });

  it('WORKFLOW_TEMPLATE_INVALID when the extension admits its type into no band it has', () => {
    const t = referral();
    delete (t as Partial<typeof t>).bandTypes;
    const out = withTemplates(t);
    expect(pick(out)).toEqual([
      { code: 'WORKFLOW_TEMPLATE_INVALID', path: '/workflows/templates/0/nodeTypes/11/band' },
    ]);
    expect(out[0]?.detail).toContain('does not admit REFERRAL');
  });

  it('WORKFLOW_TEMPLATE_IN_USE when a template a stored design is drawn in is taken out', () => {
    const out = refusals(
      { workflows: undefined },
      {
        workflowTemplatesInUse: new Map([
          ['care-journey@1', ['referral-flow']],
          ['journey-bands@1', ['post-discharge']],
        ]),
      },
    );
    expect(pick(out)).toEqual([{ code: 'WORKFLOW_TEMPLATE_IN_USE', path: '/workflows/templates' }]);
    expect(out[0]?.detail).toContain('referral-flow');
  });
  it('takes the project document schema: a template that is neither complete nor an extension is a schema violation', () => {
    expect(
      projectDocumentSchema.shape.workflows.safeParse({ templates: [{ id: 'x', version: 1 }] })
        .success,
    ).toBe(false);
  });

  it('every template code is emitted by some plant in this file', () => {
    expect([...seen].sort()).toEqual([...WORKFLOW_TEMPLATE_CONFIG_CODES].sort());
  });
});

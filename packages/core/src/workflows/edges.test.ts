import { readFileSync } from 'node:fs';
import { BUILTIN_WORKFLOW_TEMPLATES } from '@forge/contracts/workflow-templates';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { workflowJsonSchemas } from './json-schema.js';
import { checkWorkflow, parseWorkflow } from './rules.js';

const CTX = { templates: BUILTIN_WORKFLOW_TEMPLATES, designs: new Map() };

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
type Doc = Record<string, any>;

const HOP = '5e1d7c3a-2b4f-4a6e-9c8d-0f1e2a3b4c5d';
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

describe('a workflow-v2 return edge', () => {
  // cm:why HOP's loop (hop-architecture §5–§6): an OUTCOME updates the context so the rule is evaluated again
  const RETURN = 7;
  const looped = (patch: (e: Doc) => void = () => {}) => {
    const d = design();
    patch(d.edges[RETURN]);
    return d;
  };

  it('is accepted from an OUTCOME back to the CONTEXT it re-evaluates, and the emitted schema agrees', () => {
    expect(design().edges[RETURN].kind).toBe('feeds-back');
    expect(refusalsAt(looped())).toEqual([]);
    expect(emittedV2(stamped(looped()))).toBe(true);
  });

  it.each([
    [
      'a return edge that points forward',
      (e: Doc) => {
        e.from = 'context';
        e.to = 'outcome';
      },
      ['WORKFLOW_EDGE_RETURN_FORWARD /edges/7/kind'],
    ],
    [
      'a return edge to itself',
      (e: Doc) => (e.to = 'outcome'),
      ['WORKFLOW_EDGE_RETURN_FORWARD /edges/7/kind'],
    ],
    [
      'a return edge that names nothing it re-evaluates',
      (e: Doc) => delete e.reevaluates,
      ['WORKFLOW_EDGE_FIELD_MISSING /edges/7'],
    ],
    [
      'a return edge without its failure path and idempotency',
      (e: Doc) => {
        delete e.onFailure;
        delete e.idempotency;
      },
      ['WORKFLOW_EDGE_FIELD_MISSING /edges/7'],
    ],
    [
      'an edge kind its template does not declare',
      (e: Doc) => (e.kind = 'loop'),
      ['WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE /edges/7/kind'],
    ],
  ])('refuses %s by name', (_name, patch, expected) => {
    expect(refusalsAt(looped(patch))).toEqual(expected);
  });

  it('refuses `reevaluates` on a forward edge, which returns to nothing', () => {
    const d = design();
    d.edges[0].reevaluates = 'the case';
    expect(refusalsAt(d)).toEqual(['WORKFLOW_EDGE_REEVALUATES_FORWARD /edges/0/reevaluates']);
  });

  it('refuses the same loop drawn in `after`, and says to declare it as a return edge', () => {
    const d = design();
    d.steps[2].after.push('outcome');
    const parsed = parseWorkflow(d, HOP);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
    const [r, ...rest] = checkWorkflow(parsed.value, CTX);
    expect(rest).toEqual([]);
    expect(`${r?.code} ${r?.path}`).toBe('WORKFLOW_AFTER_CYCLE /steps/2/after');
    expect(r?.detail).toContain('kind: "feeds-back"');
  });

  it('refuses a return edge that names no kind as undrawn, pointing at the return kind', () => {
    const d = looped((e) => delete e.kind);
    const parsed = parseWorkflow(d, HOP);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
    const refusals = checkWorkflow(parsed.value, CTX);
    expect(refusals.map((r) => `${r.code} ${r.path}`)).toEqual(['WORKFLOW_EDGE_UNDRAWN /edges/7']);
    expect(refusals[0]?.detail).toContain('a return kind (feeds-back)');
  });
});

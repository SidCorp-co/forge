import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { workflowJsonSchemas } from './json-schema.js';
import { checkWorkflow, parseWorkflow } from './rules.js';

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
  return (parsed.ok ? checkWorkflow(parsed.value) : parsed.refusals).map(
    (r) => `${r.code} ${r.path}`,
  );
};

describe('a workflow-v2 feedback edge', () => {
  // cm:why HOP's loop (hop-architecture §5–§6): an OUTCOME updates the context and the rule is evaluated again
  const feedback = (): Doc => ({
    kind: 'feedback',
    from: 'outcome',
    to: 'followup-rule',
    reevaluates: 'follow-up rule against the context the outcome updated',
    condition: 'outcome.status in (completed, escalated)',
    action: 'reevaluate_followup_rule',
    mapping: { episode_id: 'episode.id', last_outcome: 'outcome.status' },
    idempotency: 'one re-evaluation per outcome id',
    onFailure: 'create_attention_item',
  });
  const looped = (patch: (e: Doc) => void = () => {}) => {
    const d = design();
    const e = feedback();
    patch(e);
    d.edges.push(e);
    return d;
  };

  it('is accepted from an OUTCOME back to the RULE it re-evaluates, and the emitted schema agrees', () => {
    expect(refusalsAt(looped())).toEqual([]);
    expect(emittedV2(stamped(looped()))).toBe(true);
  });

  it.each([
    [
      'a feedback edge that points forward',
      (e: Doc) => {
        e.from = 'context';
        e.to = 'outcome';
      },
      ['WORKFLOW_FEEDBACK_EDGE_FORWARD /edges/1/kind'],
    ],
    [
      'a feedback edge to itself',
      (e: Doc) => (e.to = 'outcome'),
      ['WORKFLOW_FEEDBACK_EDGE_FORWARD /edges/1/kind'],
    ],
    [
      'a feedback edge that names nothing it re-evaluates',
      (e: Doc) => delete e.reevaluates,
      ['WORKFLOW_FEEDBACK_REEVALUATES_MISSING /edges/1/reevaluates'],
    ],
    [
      'a feedback edge without its failure path and idempotency',
      (e: Doc) => {
        delete e.onFailure;
        delete e.idempotency;
      },
      ['WORKFLOW_FEEDBACK_CONTRACT_INCOMPLETE /edges/1'],
    ],
    [
      'an edge kind that is neither',
      (e: Doc) => (e.kind = 'loop'),
      ['WORKFLOW_EDGE_KIND_UNKNOWN /edges/1/kind'],
    ],
  ])('refuses %s by name', (_name, patch, expected) => {
    expect(refusalsAt(looped(patch))).toEqual(expected);
  });

  it('refuses `reevaluates` on a flow edge, which returns to nothing', () => {
    const d = design();
    d.edges[0].reevaluates = 'the case';
    expect(refusalsAt(d)).toEqual(['WORKFLOW_EDGE_REEVALUATES_ON_FLOW /edges/0/reevaluates']);
  });

  it('refuses the same loop drawn in `after`, and says to declare it as a feedback edge', () => {
    const d = design();
    d.steps[2].after.push('outcome');
    const parsed = parseWorkflow(d, HOP);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
    const [r, ...rest] = checkWorkflow(parsed.value);
    expect(rest).toEqual([]);
    expect(`${r?.code} ${r?.path}`).toBe('WORKFLOW_AFTER_CYCLE /steps/2/after');
    expect(r?.detail).toContain('kind: "feedback"');
  });

  it('refuses a backward flow edge as undrawn, pointing at the feedback kind', () => {
    const d = looped((e) => delete e.kind);
    const parsed = parseWorkflow(d, HOP);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
    const refusals = checkWorkflow(parsed.value);
    expect(refusals.map((r) => `${r.code} ${r.path}`)).toEqual(['WORKFLOW_EDGE_UNDRAWN /edges/1']);
    expect(refusals[0]?.detail).toContain('kind: "feedback"');
  });
});

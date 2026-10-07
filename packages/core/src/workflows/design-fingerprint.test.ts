import { BUILTIN_WORKFLOW_TEMPLATES } from '@forge/contracts/workflow-templates';
import { describe, expect, it } from 'vitest';
import { canonicalJson, designFingerprint } from './design.js';
import { type WorkflowWrite, workflowWriteV2Schema } from './schema.js';

const template = BUILTIN_WORKFLOW_TEMPLATES.find((t) => t.id === 'operational-flow') ?? null;

const doc = (mapping: Record<string, string>, node: Record<string, unknown>): WorkflowWrite =>
  workflowWriteV2Schema.parse({
    $schema: 'https://forge.sidcorp.co/schemas/workflow-v2.json',
    version: 2,
    project: '6b0c0f7e-0000-4000-8000-000000000001',
    flow: 'f',
    kind: 'flow',
    title: 't',
    summary: 's',
    template: { id: 'operational-flow', version: 1 },
    steps: [
      { id: 'a', does: 'x', after: [], node },
      { id: 'b', does: 'y', after: ['a'] },
    ],
    edges: [{ from: 'a', to: 'b', mapping }],
    writtenBy: {},
  });

describe('designFingerprint', () => {
  it('does not depend on the order a mapping or a nested object names its keys', () => {
    const one = doc(
      { b: '1', aaa: '2', '10': 'x', '2': 'y' },
      { type: 'RULE', contracts: [{ provider: 'p', slug: 's' }] },
    );
    const other = doc(
      { '2': 'y', '10': 'x', aaa: '2', b: '1' },
      { type: 'RULE', contracts: [{ slug: 's', provider: 'p' }] },
    );
    expect(designFingerprint(one, template)).toBe(designFingerprint(other, template));
  });

  it('reads a changed value, and a reordered array, as a change', () => {
    const base = doc({ b: '1' }, { type: 'RULE', tests: ['p', 'q'] });
    expect(designFingerprint(base, template)).not.toBe(
      designFingerprint(doc({ b: '2' }, { type: 'RULE', tests: ['p', 'q'] }), template),
    );
    expect(designFingerprint(base, template)).not.toBe(
      designFingerprint(doc({ b: '1' }, { type: 'RULE', tests: ['q', 'p'] }), template),
    );
  });

  it('hashes the template for operational-flow too', () => {
    const d = doc({}, { type: 'RULE' });
    expect(designFingerprint(d, template)).not.toBe(
      designFingerprint({ ...d, template: { id: 'operational-flow', version: 2 } }, template),
    );
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth, keeps arrays in order and leaves out undefined', () => {
    expect(canonicalJson({ b: [{ z: 1, a: null }], a: undefined, '1': 'x', c: 'ab"' })).toBe(
      '{"1":"x","b":[{"a":null,"z":1}],"c":"ab\\""}',
    );
  });
});

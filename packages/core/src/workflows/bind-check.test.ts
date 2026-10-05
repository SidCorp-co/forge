import { describe, expect, it } from 'vitest';
import { unindexedBindRefusals } from './bind-check.js';
import type { WorkflowWrite } from './schema.js';

const doc = (binds: { provider: string; slug: string; element: string }[]) =>
  ({
    steps: [
      { id: 'screen', node: { type: 'SCREEN', label: 'Products', binds } },
      { id: 'other', node: { type: 'TASK', label: 'Other' } },
    ],
  }) as unknown as WorkflowWrite;

const types = new Map([
  ['acme/orders', 'openapi'],
  ['acme/events', 'asyncapi'],
  ['acme/rpc', 'protobuf'],
  ['acme/blob', 'opaque'],
]);

describe('requirement-to-delivery impact: the design-write door refuses an unindexed bind', () => {
  it('lets an element-indexed bind through', () => {
    expect(
      unindexedBindRefusals(
        doc([{ provider: 'acme', slug: 'orders', element: 'GET /orders' }]),
        types,
      ),
    ).toEqual([]);
  });

  it('refuses asyncapi, protobuf and opaque binds by name, one per bind, at its pointer', () => {
    const r = unindexedBindRefusals(
      doc([
        { provider: 'acme', slug: 'orders', element: 'GET /orders' },
        { provider: 'acme', slug: 'events', element: 'order.created' },
        { provider: 'acme', slug: 'rpc', element: 'Orders.Get' },
        { provider: 'acme', slug: 'blob', element: 'x' },
      ]),
      types,
    );
    expect(r.map((x) => x.code)).toEqual([
      'REQUIREMENT_BINDING_NOT_INDEXED',
      'REQUIREMENT_BINDING_NOT_INDEXED',
      'REQUIREMENT_BINDING_NOT_INDEXED',
    ]);
    expect(r.map((x) => x.path)).toEqual([
      '/steps/0/node/binds/1',
      '/steps/0/node/binds/2',
      '/steps/0/node/binds/3',
    ]);
    expect(r[0]?.detail).toContain('order.created of acme/events, an asyncapi contract');
  });

  it('does not refuse a contract with no recorded version (its type is unknown; the pin decides)', () => {
    expect(
      unindexedBindRefusals(doc([{ provider: 'acme', slug: 'later', element: 'x' }]), types),
    ).toEqual([]);
  });
});

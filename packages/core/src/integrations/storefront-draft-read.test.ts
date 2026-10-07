// Reading the drafts behind thirty verdicts looked the binding up and asked the provider thirty
// times, one workflow each; every issue read on a storefront project paid it. The read is now one
// lookup and one provider call for every workflow named.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorefrontDraftReading } from './types.js';

const calls = vi.hoisted(() => ({ lookups: 0, reads: [] as (readonly string[])[] }));
const held = vi.hoisted(() => ({ binding: true }));

vi.mock('./store.js', () => ({
  findBindingWithConnectionById: async () => {
    calls.lookups += 1;
    return held.binding ? { connection: { id: 'conn-1' }, binding: { config: {} } } : null;
  },
  effectiveConfig: () => ({}),
  decryptConnectionSecrets: () => ({}),
}));
vi.mock('./registry.js', () => ({
  getIntegration: (provider: string) =>
    provider === 'autoflow'
      ? {
          storefrontDrafts: async ({ workflowIds }: { workflowIds: readonly string[] }) => {
            calls.reads.push(workflowIds);
            // answers every workflow but the last, as a provider that drops one would
            return new Map<string, StorefrontDraftReading>(
              workflowIds
                .slice(0, -1)
                .map((id) => [id, { kind: 'read', draftVersion: `v-${id}`, workflowCode: id }]),
            );
          },
        }
      : undefined,
}));

const { readStorefrontDrafts } = await import('./storefront-draft-read.js');

beforeEach(() => {
  calls.lookups = 0;
  calls.reads = [];
  held.binding = true;
});

describe('readStorefrontDrafts', () => {
  it('looks the binding up once and asks the provider once for every workflow named', async () => {
    const ids = ['wf-1', 'wf-2', 'wf-2', 'wf-3'];
    const read = await readStorefrontDrafts({
      provider: 'autoflow',
      binding: 'b-1',
      workflowIds: ids,
    });
    expect(calls.lookups).toBe(1);
    expect(calls.reads).toEqual([['wf-1', 'wf-2', 'wf-3']]);
    expect(read.get('wf-1')).toEqual({
      kind: 'read',
      draftVersion: 'v-wf-1',
      workflowCode: 'wf-1',
    });
    // a workflow the provider did not answer reads unreadable, naming it, never absent
    expect(read.get('wf-3')).toEqual({
      kind: 'unreadable',
      detail: 'the autoflow draft reader answered no reading of workflow `wf-3`',
    });
  });

  it('reads nothing for no workflow', async () => {
    const read = await readStorefrontDrafts({
      provider: 'autoflow',
      binding: 'b-1',
      workflowIds: [],
    });
    expect(read.size).toBe(0);
    expect(calls.lookups).toBe(0);
  });

  it('answers every workflow unreadable, naming the binding, when core holds no such binding', async () => {
    held.binding = false;
    const read = await readStorefrontDrafts({
      provider: 'autoflow',
      binding: 'b-gone',
      workflowIds: ['wf-1', 'wf-2'],
    });
    expect(calls.reads).toEqual([]);
    expect([...read.values()].map((r) => r.kind)).toEqual(['unreadable', 'unreadable']);
    expect(read.get('wf-2')).toMatchObject({ detail: expect.stringContaining('`b-gone`') });
  });

  it('names a provider with no draft reader', async () => {
    const read = await readStorefrontDrafts({
      provider: 'shopify',
      binding: 'b-1',
      workflowIds: ['wf-1'],
    });
    expect(read.get('wf-1')).toMatchObject({
      kind: 'unreadable',
      detail: expect.stringContaining('no draft reader for provider `shopify`'),
    });
  });
});

// Reading the drafts behind thirty verdicts looked the binding up and asked the provider thirty
// times, one workflow each; every issue read on a storefront project paid it. The read is now one
// lookup and one provider call for every workflow named. A person's read is shown the drafts read a
// moment ago, each saying when it was read; forge-dev's attention and home asked Autoflow once a
// storefront project on every read (ISS-1070 r14).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRESH_MS, TRUST_MS, withObservedReads } from '../db/observed-reads.js';
import { withReadMemo } from '../db/read-memo.js';
import { backgroundSettled } from '../lib/background.js';
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
      readAt: expect.any(String),
    });
    // a workflow the provider did not answer reads unreadable, naming it, never absent
    expect(read.get('wf-3')).toEqual({
      kind: 'unreadable',
      detail: 'the autoflow draft reader answered no reading of workflow `wf-3`',
      readAt: expect.any(String),
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

describe("a person's read of the drafts", () => {
  const asPerson = <T>(fn: () => Promise<T>) => withReadMemo(() => withObservedReads(fn));
  let bindings = 0;
  const ask = (binding: string, workflowIds: readonly string[]) =>
    readStorefrontDrafts({ provider: 'autoflow', binding, workflowIds });

  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-08T12:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('asks the provider once for every read made at once, and not again while the reading is fresh', async () => {
    const binding = `person-${++bindings}`;
    await asPerson(() => Promise.all([ask(binding, ['wf-1', 'wf-9']), ask(binding, ['wf-1'])]));
    expect(calls.reads).toHaveLength(1);
    vi.setSystemTime(Date.now() + FRESH_MS - 1);
    const again = await asPerson(() => ask(binding, ['wf-1']));
    expect(calls.reads).toHaveLength(1);
    // it says when it was read, never the time it is shown
    expect(again.get('wf-1')?.readAt).toBe('2026-11-08T12:00:00.000Z');
  });

  it('shows a reading past fresh as it was read, saying so, while a new one is read behind it', async () => {
    const binding = `person-${++bindings}`;
    await asPerson(() => ask(binding, ['wf-1', 'wf-9']));
    vi.setSystemTime(Date.now() + FRESH_MS);
    const shown = await asPerson(() => ask(binding, ['wf-1']));
    expect(shown.get('wf-1')?.readAt).toBe('2026-11-08T12:00:00.000Z');
    await backgroundSettled();
    expect(calls.reads).toHaveLength(2);
    const next = await asPerson(() => ask(binding, ['wf-1']));
    expect(next.get('wf-1')?.readAt).toBe('2026-11-08T12:00:30.000Z');
  });

  it('never shows a reading too old to trust, nor one that never read the workflow asked', async () => {
    const binding = `person-${++bindings}`;
    await asPerson(() => ask(binding, ['wf-1', 'wf-9']));
    vi.setSystemTime(Date.now() + TRUST_MS);
    const late = await asPerson(() => ask(binding, ['wf-1']));
    expect(calls.reads).toHaveLength(2);
    expect(late.get('wf-1')?.readAt).toBe('2026-11-08T12:05:00.000Z');
    // a workflow the held reading never asked is read, with every one asked before it
    await asPerson(() => ask(binding, ['wf-2']));
    expect(calls.reads.at(-1)).toEqual(['wf-1', 'wf-9', 'wf-2']);
  });

  it("reads afresh outside a person's read: a release hold and a gate read the drafts now", async () => {
    const binding = `person-${++bindings}`;
    await asPerson(() => ask(binding, ['wf-1', 'wf-9']));
    await ask(binding, ['wf-1', 'wf-9']);
    await withReadMemo(() => ask(binding, ['wf-1', 'wf-9']));
    expect(calls.reads).toHaveLength(3);
  });
});

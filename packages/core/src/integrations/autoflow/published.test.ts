// What Autoflow publishes, read in the identity a storefront draft verdict names: the published
// graph's sha-256 as core reads a draft, and when that graph first went live — the archive of
// replaced versions says when a revert's graph was first published.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autoflowDraftVersion } from './draft.js';

const site = vi.hoisted(() => ({
  queries: [] as string[],
  answers: [] as Array<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }>,
}));

vi.mock('./live-read.js', () => ({
  autoflowLiveRead: async (_args: unknown, _config: unknown, query: string) => {
    site.queries.push(query);
    return site.answers.shift() ?? { ok: false, reason: 'no answer planted' };
  },
}));

const { autoflowStorefrontPublished } = await import('./published.js');

const GRAPH_A = { nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const GRAPH_B = { edges: [], nodes: [{ type: 'trigger', id: 'n2' }] };

const read = (workflowIds: string[]) =>
  autoflowStorefrontPublished({
    connectionId: 'conn-1',
    config: { shop: 'hop' },
    readSecrets: () => ({}),
    workflowIds,
  });

beforeEach(() => {
  site.queries = [];
  site.answers = [];
});

describe('autoflowStorefrontPublished', () => {
  it('reads each published graph in the draft identity, and a revert as first live when its graph first was', async () => {
    site.answers = [
      {
        ok: true,
        data: {
          backendWorkflows: [
            {
              id: '155',
              code: 'hop_attention_sweep',
              version: 1,
              published_at: '2026-10-07T15:37:55Z',
              published: GRAPH_A,
            },
            {
              id: '102',
              code: 'hop_derived_state',
              version: 3,
              published_at: '2026-10-07T16:00:00Z',
              published: GRAPH_B,
            },
            { id: '167', code: 'hop_campaign', version: 0, published_at: null, published: null },
          ],
        },
      },
      {
        ok: true,
        data: {
          v0: [],
          v1: [
            { graph: GRAPH_A, published_at: '2026-10-07T15:36:52Z' },
            { graph: GRAPH_B, published_at: '2026-10-06T09:00:00Z' },
          ],
        },
      },
    ];
    const got = await read(['155', '102', '167', '999']);
    expect(site.queries[1]).toContain('v0: backendWorkflowVersions(code: "hop_attention_sweep")');
    expect(site.queries[1]).toContain('v1: backendWorkflowVersions(code: "hop_derived_state")');
    expect(got.get('155')).toEqual({
      kind: 'published',
      workflowCode: 'hop_attention_sweep',
      version: 1,
      publishedAt: '2026-10-07T15:37:55Z',
      graphVersion: autoflowDraftVersion(GRAPH_A),
      firstLiveAt: '2026-10-07T15:37:55Z',
    });
    expect(got.get('102')).toMatchObject({
      graphVersion: autoflowDraftVersion(GRAPH_B),
      publishedAt: '2026-10-07T16:00:00Z',
      firstLiveAt: '2026-10-06T09:00:00Z',
    });
    expect(got.get('167')).toEqual({ kind: 'unpublished', workflowCode: 'hop_campaign' });
    expect(got.get('999')).toMatchObject({ kind: 'missing' });
  });

  it('answers every workflow unreadable with the reason when the site answers nothing', async () => {
    site.answers = [{ ok: false, reason: 'unauthorized: token expired' }];
    const got = await read(['155']);
    expect(got.get('155')).toEqual({
      kind: 'unreadable',
      detail: 'Autoflow site `hop` answered no published workflow: unauthorized: token expired',
    });
  });

  it('answers unreadable when the archive cannot be read, rather than a first-live time it did not read', async () => {
    site.answers = [
      {
        ok: true,
        data: {
          backendWorkflows: [
            {
              id: '155',
              code: 'hop_attention_sweep',
              version: 2,
              published_at: '2026-10-07T15:37:55Z',
              published: GRAPH_A,
            },
          ],
        },
      },
      { ok: false, reason: 'graphql_error: unknown field' },
    ];
    expect((await read(['155'])).get('155')).toMatchObject({
      kind: 'unreadable',
      detail: expect.stringContaining('no version history'),
    });
  });
});

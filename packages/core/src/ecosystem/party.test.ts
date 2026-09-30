import { describe, expect, it } from 'vitest';
import { edgeVisible, type PartyGraph, sightOf, visibleMembers } from './party.js';
import type { VisibilityMode } from './schema.js';
import type { EdgeRow } from './store.js';

const ECO = 'eco';
const edge = (consumer: string, provider: string): EdgeRow => ({
  consumerProjectId: consumer,
  providerProjectId: provider,
  contractSlug: 'checkout-api',
  ecosystemId: ECO,
  builtAgainst: '3.2.0',
});

const graph = (mode: VisibilityMode, active = ['platform', 'store-a', 'store-b']): PartyGraph => ({
  active: new Map([[ECO, new Set(active)]]),
  visibility: new Map([[ECO, mode]]),
  edges: [edge('store-a', 'platform'), edge('store-b', 'platform')],
});

describe('a member sees its counterparties and nothing else of the ecosystem', () => {
  it('lets a store see the platform it consumes from', () => {
    expect([...sightOf(graph('counterparties'), new Set(['store-a']), 'platform').keys()]).toEqual([
      ECO,
    ]);
  });

  it('lets the platform see each store that consumes from it', () => {
    expect(sightOf(graph('counterparties'), new Set(['platform']), 'store-b').size).toBe(1);
  });

  it('hides one store from another under counterparties', () => {
    expect(sightOf(graph('counterparties'), new Set(['store-a']), 'store-b').size).toBe(0);
    expect([...visibleMembers(graph('counterparties'), new Set(['store-a']), ECO)].sort()).toEqual([
      'platform',
      'store-a',
    ]);
  });

  it('shows every member when the ecosystem says all', () => {
    expect(sightOf(graph('all'), new Set(['store-a']), 'store-b').size).toBe(1);
    expect(visibleMembers(graph('all'), new Set(['store-a']), ECO).size).toBe(3);
  });

  it('never shows another pair edge under counterparties, and does under all', () => {
    const other = edge('store-b', 'platform');
    expect(edgeVisible(graph('counterparties'), other, new Set(['store-a']))).toBe(false);
    expect(edgeVisible(graph('all'), other, new Set(['store-a']))).toBe(true);
  });

  it('shows nothing to a project whose membership is no longer active', () => {
    const g = graph('all', ['platform', 'store-b']);
    expect(sightOf(g, new Set(['store-a']), 'platform').size).toBe(0);
    expect(visibleMembers(g, new Set(['store-a']), ECO).size).toBe(0);
  });

  it('drops a counterparty whose provider left', () => {
    const g = graph('counterparties', ['store-a', 'store-b']);
    expect(sightOf(g, new Set(['store-a']), 'store-b').size).toBe(0);
  });
});

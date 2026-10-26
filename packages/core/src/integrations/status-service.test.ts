/**
 * ISS-1421 r4 repair 1 — the Integrations tab printed the status read model's internals to people:
 * "no Coolify integration configured", "no GitHub App is bound to this project", "last health: ok".
 * Every detail a card carries is a plain sentence: a capital, a full stop, no field or code word.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
(await import('./register-all.js')).registerAllIntegrations();

const { buildProviderCards, CARD_WORDS } = await import('./status-service.js');

const SENTENCE = /^[A-Z][^_]*\.$/;

function row(over: Partial<Parameters<typeof buildProviderCards>[0]['rows'][number]> = {}) {
  return {
    id: 'b-1',
    provider: 'coolify' as const,
    role: 'deploy',
    stages: ['live'],
    config: {},
    active: true,
    lastHealthStatus: null,
    lastHealthAt: null,
    breakerOpenedAt: null,
    ...over,
  };
}

function cardsFor(rows: ReturnType<typeof row>[]) {
  return buildProviderCards({ rows, provider: 'coolify', label: 'Coolify', alwaysEnvKeyed: true });
}

describe('the words a status card shows a person', () => {
  it('says a provider with no connection is not set up, in a sentence', () => {
    expect(cardsFor([])[0]?.detail).toBe('Not set up for this project.');
  });

  it('says a connection never checked, turned off, or checked, in sentences', () => {
    expect(cardsFor([row()])[0]?.detail).toBe(CARD_WORDS.neverChecked);
    expect(cardsFor([row({ active: false })])[0]?.detail).toBe(CARD_WORDS.disabled);
    expect(cardsFor([row({ lastHealthStatus: 'ok' })])[0]?.detail).toBe('The last check passed.');
    expect(cardsFor([row({ lastHealthStatus: 'needs_reauth' })])[0]?.detail).toBe(
      'It needs signing in again.',
    );
  });

  it.each(Object.entries(CARD_WORDS))('%s is a plain sentence', (_, words) => {
    const sentence = typeof words === 'function' ? words(1, 2) : words;
    expect(sentence).toMatch(SENTENCE);
    expect(sentence).not.toMatch(/\bno sync|transport|configured\b|bound\b/);
  });
});

// ISS-1421 r34, judge-138: two storefronts of one project read the same on the tab, so a removed one
// and the one connected again, or two labelled ones, could not be told apart by their rows.
describe('the name a binding card carries beside its state', () => {
  it('carries a labelled binding label, and none for the unlabelled one', () => {
    const cards = cardsFor([row({ id: 'b-1', label: '' }), row({ id: 'b-2', label: 'partner-a' })]);
    expect(cards.find((c) => c.meta?.bindingId === 'b-1')?.meta).not.toHaveProperty('label');
    expect(cards.find((c) => c.meta?.bindingId === 'b-2')?.meta?.label).toBe('partner-a');
  });
});

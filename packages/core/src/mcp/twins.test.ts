// ISS-1251: one act, one card. A REST write that does another door's act is folded into that door,
// its card the one either side carries, and a call through it counts there, told apart as a twin's.

import { describe, expect, it } from 'vitest';
import type { CatalogDoor } from '../lib/door-catalog.js';
import { card } from '../prompt/index.js';
import { catalogOf, twinned } from './door-catalog.js';

const taught = card('POST /api/things/:id/confirm-wait', 'feedback', {
  purpose: 'Waits on a later event.',
  situations: [{ when: 'a fix can only be tested later', do: 'set the wait' }],
  practice: ['Say until when.'],
  audience: ['master'],
});
const rest = (id: string, more: Partial<CatalogDoor> = {}): CatalogDoor => ({
  id,
  surface: 'rest',
  summary: null,
  feature: 'x',
  ...more,
});
const DOORS: CatalogDoor[] = [
  { id: 'thing.decide', surface: 'mcp', summary: null, feature: 'forge_thing', paths: ['a'] },
  rest('POST /api/things/:id/decision', { paths: ['b'] }),
  rest('POST /api/things/:id/confirm-wait', { card: taught }),
  rest('POST /api/forge/things/:key/confirm-wait'),
];
const TWINS = {
  'thing.decide': ['POST /api/things/:id/decision'],
  'POST /api/things/:id/confirm-wait': ['POST /api/forge/things/:key/confirm-wait'],
};

describe('a REST twin is folded into the door whose act it does', () => {
  it('leaves one row per act, the twin listed on it, its card and paths shared', () => {
    const doors = twinned(DOORS, TWINS);
    expect(doors.map((d) => d.id)).toEqual(['thing.decide', 'POST /api/things/:id/confirm-wait']);
    expect(doors[0]).toMatchObject({ twins: ['POST /api/things/:id/decision'], paths: ['a', 'b'] });
    expect(doors[1]?.card).toBe(taught);
  });

  it('counts a call through a twin on the act, and says it came through the twin', () => {
    const catalog = catalogOf(twinned(DOORS, TWINS));
    const decision = { tool: 'rest', action: 'POST /api/things/9/decision' };
    const forge = { tool: 'rest', action: 'POST /api/forge/things/FB-1/confirm-wait' };
    const own = { tool: 'rest', action: 'POST /api/things/9/confirm-wait' };
    expect(catalog.doorOf(decision)?.id).toBe('thing.decide');
    expect(catalog.viaTwin(decision)).toBe(true);
    expect(catalog.doorOf(forge)?.id).toBe('POST /api/things/:id/confirm-wait');
    expect(catalog.viaTwin(forge)).toBe(true);
    expect(catalog.viaTwin(own)).toBe(false);
    expect(catalog.viaTwin({ tool: 'forge_thing', action: 'decide' })).toBe(false);
  });

  it('refuses a pair this build does not serve, and an act carrying two cards, by name', () => {
    expect(() => twinned(DOORS, { 'thing.gone': ['POST /api/things/:id/decision'] })).toThrow(
      /names thing\.gone/,
    );
    expect(() => twinned(DOORS, { 'thing.decide': ['POST /api/nowhere'] })).toThrow(
      /names POST \/api\/nowhere/,
    );
    const two = DOORS.map((d) =>
      d.id === 'thing.decide' ? { ...d, card: { ...taught, id: 'thing.decide' } } : d,
    );
    expect(() => twinned(two, { 'thing.decide': ['POST /api/things/:id/confirm-wait'] })).toThrow(
      /one act carries two cards, thing\.decide/,
    );
  });
});

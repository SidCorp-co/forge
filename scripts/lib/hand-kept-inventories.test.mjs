// @direct-test-of scripts/check-hand-kept-inventories.mjs
// @direct-test-of .forge/conformance.json

import { describe, expect, it } from 'vitest';
import {
  allowanceFaults,
  findInventories,
  judge,
  readRegistry,
  routeKey,
} from './hand-kept-inventories.mjs';

const TIMERS = readRegistry(
  { name: 'timers', source: 't.ts', reader: 'property', property: 'name' },
  [
    [
      't.ts',
      `export const T = [{ name: 'a-sweep' }, { name: 'b-sweep' }, { name: 'c-sweep' }, { name: 'd-sweep' }];`,
    ],
  ],
);
const ROUTES = readRegistry({ name: 'routes', source: 'api.json', reader: 'openapi-routes' }, [
  [
    'api.json',
    JSON.stringify({
      paths: {
        '/api/a/{id}': { get: {} },
        '/api/b': { get: {}, post: {} },
        '/api/c': {},
        '/api/d': {},
      },
    }),
  ],
]);
const registries = [
  { name: 'timers', source: 't.ts', reader: 'property', min: 4, names: TIMERS.names },
  { name: 'routes', source: 'api.json', reader: 'openapi-routes', min: 4, names: ROUTES.names },
];
const find = (text) =>
  findInventories('x.test.ts', text, registries).map((f) => ({ file: 'x.test.ts', ...f }));

describe('a test keeps no hand-kept list of what a registry registers (ISS-1254)', () => {
  it('reads each registry shape, erasing parameter names from a route', () => {
    expect([...TIMERS.names]).toEqual(['a-sweep', 'b-sweep', 'c-sweep', 'd-sweep']);
    expect(ROUTES.names).toContain('GET /api/a/:_');
    expect(routeKey('/api/a/:projectId')).toBe(routeKey('/api/a/{id}'));
    const ARRAY = { name: 'doors', source: 'd.ts', reader: 'array', symbol: 'D' };
    expect(readRegistry(ARRAY, [['d.ts', `export const D = ['x', 'y'] as const;`]]).names).toEqual(
      new Set(['x', 'y']),
    );
    expect(readRegistry(ARRAY, [['d.ts', `export const D = [...more];`]]).unreadable).toMatch(
      /not a string literal/,
    );
    expect(readRegistry(ARRAY, [['d.ts', 'export const E = [];']]).unreadable).toMatch(
      /declares no D/,
    );
  });

  it('refuses a planted list of registered names, naming the file, the line and the registry', () => {
    const planted = find(
      `it('x', () => {\n  expect(names).toEqual(['a-sweep', 'b-sweep', 'c-sweep', 'd-sweep']);\n});`,
    );
    const { refused } = judge(planted, registries);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(
      /^HAND_KEPT_INVENTORY x\.test\.ts:2 lists 4 timers by hand \(a-sweep, b-sweep, c-sweep, …\)\. Read them from t\.ts/,
    );
  });

  it('reads a route list whatever its parameter names, and a test.each case list too', () => {
    const text = `it.each(['/api/a/:projectId', '/api/b', 'POST /api/b', '/api/c'])('%s', () => {});`;
    expect(find(text).map((f) => f.registry)).toEqual(['routes']);
  });

  it('passes a list below the floor, one mostly of other words, and a table keyed by the registry', () => {
    expect(find(`const few = ['a-sweep', 'b-sweep', 'c-sweep'];`)).toEqual([]);
    expect(
      find(`const mixed = ['a-sweep', 'b-sweep', 'c-sweep', 'd-sweep', 'e', 'f', 'g', 'h', 'i'];`),
    ).toEqual([]);
    const table = `const WHY = { 'a-sweep': 'r', 'b-sweep': 'r', 'c-sweep': 'r', 'd-sweep': 'r' };`;
    expect(find(table)).toEqual([]);
  });

  it('excuses an allowed file, and refuses an allowance that covers nothing as stale', () => {
    const planted = find(`const L = ['a-sweep', 'b-sweep', 'c-sweep', 'd-sweep'];`);
    const allowed = [{ file: 'x.test.ts', registry: 'timers', why: 'w', endsWhen: 'e' }];
    expect(judge(planted, registries, allowed)).toEqual({ refused: [], excused: 1 });
    expect(judge([], registries, allowed).refused).toEqual([
      'HAND_KEPT_ALLOWANCE_STALE x.test.ts (timers) is allowed but lists none: remove the allowance',
    ]);
  });

  it('refuses an allowance that is not priced or names no registry', () => {
    expect(allowanceFaults([{ file: 'x.test.ts', registry: 'nope' }], ['timers'])).toEqual([
      'allowed[0] names registry "nope", not one of timers',
      'allowed[0] carries no `why` — an allowance is priced or it is not taken',
      'allowed[0] carries no `endsWhen` — an allowance is priced or it is not taken',
    ]);
  });
});

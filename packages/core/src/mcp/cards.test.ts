// ISS-1251: a door's capability card sits beside it, is judged whole when the registry is built, is
// found by the situation an agent is in, and is answered with the action's input.

import { describe, expect, it } from 'vitest';
import type { McpTool } from '../lib/tool.js';
import { AFFORDANCE_CARDS } from '../prompt/index.js';
import { actionCatalog, findActions } from './action-catalog.js';
import { cardsOf, withCard } from './cards.js';
import { carded, catalogOf } from './door-catalog.js';
import { mcpTools } from './server.js';

const catalog = actionCatalog(mcpTools({ principal: { userId: 'cards-test' } } as never));

const tool = (cards: McpTool['cards']) =>
  ({ name: 'forge_thing', route: '/api/things', cards }) as unknown as McpTool;
const body = {
  purpose: 'Does the thing.',
  situations: [{ when: 'you need the thing', do: 'call it' }],
  practice: ['Call it once.'],
  audience: ['run'],
} as const;

describe("a door's capability card (ISS-1251)", () => {
  it('is attached to its action, owned by its tool and that tool’s REST twin', () => {
    const door = catalog.get('feedback.door');
    expect(door?.card).toMatchObject({
      id: 'feedback.door',
      owner: expect.stringContaining('forge_feedback'),
    });
    expect(door?.card?.situations.length).toBeGreaterThan(1);
  });

  it('is found from the situation an agent is in, not only from the door’s name', () => {
    const found = findActions(catalog, 'a guide left me guessing when to use something', 5);
    expect(found.map((e) => e.id)).toContain('feedback.door');
  });

  it('refuses by name a card for an action the tool does not take, or one that does not stand', () => {
    expect(() =>
      cardsOf(
        tool({
          nope: {
            ...body,
            situations: [...body.situations],
            practice: [...body.practice],
            audience: ['run'],
          },
        }),
        ['get'],
      ),
    ).toThrow(/declares a card for nope/);
    expect(() =>
      cardsOf(tool({ get: { ...body, situations: [], practice: ['x y z'], audience: ['run'] } }), [
        'get',
      ]),
    ).toThrow(/card for get does not stand: situations/);
    expect(
      cardsOf(
        tool({
          get: {
            ...body,
            situations: [...body.situations],
            practice: [...body.practice],
            audience: ['run'],
          },
        }),
        ['get'],
      ).get('get'),
    ).toMatchObject({
      id: 'thing.get',
      owner: 'forge_thing (/api/things)',
      scenarios: [],
    });
  });

  it('refuses an example naming an argument the action does not take', () => {
    const [card] = cardsOf(
      tool({
        get: {
          ...body,
          situations: [...body.situations],
          practice: [...body.practice],
          audience: ['run'],
          example: { wrong: 1 },
        },
      }),
      ['get'],
    ).values();
    expect(() => withCard({ id: 'thing.get', input: { properties: { right: {} } } }, card)).toThrow(
      /naming `wrong`/,
    );
  });

  it('the REST cards each name a door this build serves, and one that names none is refused', () => {
    const rest = AFFORDANCE_CARDS.map((c) => ({
      id: c.id,
      surface: 'rest' as const,
      summary: null,
      feature: 'x',
    }));
    expect(catalogOf(carded(rest, AFFORDANCE_CARDS)).doors.every((d) => d.card)).toBe(true);
    expect(() => carded(rest.slice(1), AFFORDANCE_CARDS)).toThrow(/a capability card names/);
  });
});

// ISS-1251: a door's capability card sits beside it, is judged whole when the registry is built, is
// found by the situation an agent is in, and is answered with the action's input.

import { TIER0_MAP_MAX_CHARS } from '@forge/contracts/capability-cards';
import { CARD_FAMILIES } from '@forge/contracts/card-families';
import { describe, expect, it } from 'vitest';
import {
  type CatalogDoor,
  doorNames,
  mergedLine,
  moreLine,
  tier0Map,
} from '../lib/door-catalog.js';
import type { McpTool } from '../lib/tool.js';
import { sourceOf } from '../lib/tool.js';
import { AFFORDANCE_CARDS } from '../prompt/index.js';
import { SUPPORT_ACT_CARDS } from '../support/act-cards.js';
import { actionCatalog, findActions } from './action-catalog.js';
import { cardsOf, describedCard, withCard } from './cards.js';
import { carded, catalogOf, mcpDoors, servedDoorCatalog } from './door-catalog.js';
import { mcpTools } from './server.js';
import { UNCARDED_DOORS } from './uncarded-doors.js';

const catalog = actionCatalog(mcpTools({ principal: { userId: 'cards-test' } } as never));

const tool = (
  cards: McpTool['cards'],
  source: string | undefined = 'packages/core/src/thing/tool.ts',
) => ({ name: 'forge_thing', route: '/api/things', cards, source }) as unknown as McpTool;
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

  it('names the paths its door lives in, and refuses a carded tool that names no source', () => {
    expect(sourceOf('file:///app/dist/forge-door/tool.js')).toBe(
      'packages/core/src/forge-door/tool.ts',
    );
    expect(sourceOf('file:///r/packages/core/src/mcp/x.ts')).toBe('packages/core/src/mcp/x.ts');
    expect(mcpDoors().find((d) => d.id === 'feedback.door')?.paths).toEqual([
      'packages/core/src/forge-door',
    ]);
    const rest = AFFORDANCE_CARDS.map((c) => ({
      id: c.id,
      surface: 'rest' as const,
      summary: null,
      feature: 'x',
    }));
    expect(carded(rest, AFFORDANCE_CARDS).find((d) => d.id === 'POST /api/memory')?.paths).toEqual([
      'packages/core/src/memory',
    ]);
    expect(() =>
      cardsOf(
        tool(
          {
            get: {
              ...body,
              situations: [...body.situations],
              practice: [...body.practice],
              audience: ['run'],
            },
          },
          '',
        ),
        ['get'],
      ),
    ).toThrow(/names no source/);
  });

  it('shows a lesson folded into a card as proposed until its code carries it', () => {
    const card = catalog.get('feedback.door')?.card;
    if (!card) throw new Error('feedback.door has no card');
    const said = describedCard(card, [
      {
        id: 'd1',
        field: 'situation',
        op: 'add',
        text: 'when a refusal named no fix',
        replaces: null,
        fromLesson: 'L-9',
        projectId: null,
        at: '2026-11-16T00:00:00Z',
      },
    ]);
    expect(said).toMatchObject({
      proposed: [{ field: 'situation', text: 'when a refusal named no fix', from: 'L-9' }],
    });
    expect(describedCard(card)).not.toHaveProperty('proposed');
    const doors = [
      { id: 'feedback.door', surface: 'mcp' as const, summary: null, feature: 'f', card },
    ];
    const map = tier0Map(
      doors,
      'bot',
      new Map([['feedback.door', ['when a refusal named no fix']]]),
    ).text;
    expect(map).toContain('- (proposed) when a refusal named no fix → feedback.door');
    expect(tier0Map(doors, 'person')).toEqual({ text: '', carried: [], reach: 0 });
  });

  it('carries the most used cards whole within its cap, and leaves the rest to Tier 1', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `thing.a${i}`,
      surface: 'mcp' as const,
      summary: null,
      feature: 'f',
      card: {
        id: `thing.a${i}`,
        owner: 'f',
        purpose: 'p',
        situations: [
          { when: `you are in situation number ${i} of a long list of them`, do: 'call it' },
        ],
        practice: ['x'],
        audience: ['run' as const],
        scenarios: [],
      },
    }));
    const map = tier0Map(
      many,
      'run',
      new Map(),
      new Map([
        ['thing.a39', 9],
        ['thing.a7', 3],
      ]),
    );
    expect(map.reach).toBe(40);
    expect(map.carried.slice(0, 2)).toEqual(['thing.a39', 'thing.a7']);
    expect(map.carried.length).toBeLessThan(40);
    expect(map.text.length).toBeLessThanOrEqual(2500);
  });
});

// ISS-1252: a room agent adds, cites and reads reference sources through forge_support, a master and
// its runs through forge_references; one act is taught once to each audience, never by both cards
describe('a reference act is taught once per audience', () => {
  it.each([
    ['support.references', 'references.search'],
    ['support.reference_add', 'references.add'],
    ['support.reference_cite', 'references.cite'],
    ['support.reference_propose', 'references.propose'],
  ])('%s teaches the room agent, %s masters and runs', (room, door) => {
    const roomCard = catalog.get(room)?.card;
    const doorCard = catalog.get(door)?.card;
    expect(roomCard?.audience).toEqual(['bot']);
    expect(doorCard?.audience).toEqual(expect.arrayContaining(['master', 'run']));
    expect(doorCard?.audience.filter((a) => roomCard?.audience.includes(a))).toEqual([]);
  });
});

/**
 * Whether a map reaches a door: a card of a family through its family's line naming the door's tool
 * (each act, or the tool merged with its count), a card of none by its own name.
 */
function reaches(text: string, door: CatalogDoor, names: ReadonlyMap<string, string>): boolean {
  const name = names.get(door.id) ?? door.id;
  const [tool, act] = name.split('.') as [string, string];
  const family = door.card?.family;
  if (!family) return text.split('\n').some((l) => l.endsWith(`→ ${name}`));
  const line = text.split('\n').find((l) => l.startsWith(`- when ${CARD_FAMILIES[family]} → `));
  if (!line) return false;
  const named = new RegExp(`${tool}\\.([a-z_]+ · )*${act}( · |$)`);
  const merged = new RegExp(`(^|→ | · )${tool}\\.\\*( \\(\\d+\\))?( · |$)`);
  return named.test(line) || merged.test(line);
}

// ISS-1251 criterion 5: a cap on the Tier-0 map triggers merging, never truncation. A card of a family
// is one door on its family's line, so the room agent's map names every act it holds within its cap.
describe('a Tier-0 map merges a family of acts into one line', () => {
  const door = (id: string, family?: keyof typeof CARD_FAMILIES) => ({
    id,
    surface: 'mcp' as const,
    summary: null,
    feature: 'f',
    card: {
      id,
      owner: 'f',
      purpose: 'p',
      situations: [
        { when: `you need ${id}`, do: 'call it' },
        { when: 'a second case', do: 'x' },
      ],
      practice: ['x'],
      audience: ['bot' as const],
      scenarios: [],
      ...(family ? { family } : {}),
    },
  });

  it('gives a family one line naming each door once, and a card of none its own lines', () => {
    const map = tier0Map(
      [door('support.a', 'room.answer'), door('support.b', 'room.answer'), door('other.c')],
      'bot',
      new Map([['support.b', ['when a lesson said so']]]),
      new Map([['support.b', 2]]),
    );
    expect(map.text.split('\n')).toEqual([
      `- when ${CARD_FAMILIES['room.answer']} → support.b · a`,
      '- (proposed) when a lesson said so → support.b',
      '- when you need other.c → other.c',
      '- when a second case → other.c',
    ]);
    expect(map.carried).toEqual(['support.b', 'support.a', 'other.c']);
  });

  it('carries every act a room agent holds, each reached through its line, within its cap', () => {
    const doors = servedDoorCatalog().doors;
    const map = tier0Map(doors, 'bot');
    const acts = Object.keys(SUPPORT_ACT_CARDS);
    expect(map.carried.length).toBe(map.reach);
    for (const act of acts) {
      expect(map.carried, act).toContain(`support.${act}`);
      const door = doors.find((d) => d.id === `support.${act}`) as CatalogDoor;
      expect(reaches(map.text, door, doorNames(doors)), act).toBe(true);
    }
    expect(map.text.length).toBeLessThanOrEqual(TIER0_MAP_MAX_CHARS);
  });

  // ISS-1251 c5 (master, 2026-11-16): every audience's map names capabilities, never routes, and
  // every card it teaches is on it or behind its last line's count and the door that finds it
  it.each(['bot', 'master', 'run', 'person'] as const)(
    'reaches every card the %s is taught through its family line or its name, within its cap',
    (audience) => {
      const doors = servedDoorCatalog().doors;
      const names = doorNames(doors);
      const map = tier0Map(doors, audience);
      expect(map.text.length).toBeLessThanOrEqual(TIER0_MAP_MAX_CHARS);
      expect(map.text).not.toMatch(/→ (POST|PUT|PATCH|DELETE) \//);
      const left = map.reach - map.carried.length;
      if (left > 0) expect(map.text.split('\n').at(-1)).toBe(moreLine(left));
      for (const id of map.carried) {
        const door = doors.find((d) => d.card?.id === id) as CatalogDoor;
        expect(reaches(map.text, door, names), id).toBe(true);
      }
      expect(left, `${audience} leaves ${left} cards to forge_find`).toBe(0);
    },
  );

  it('names a door left out by the count on its last line, within its cap', () => {
    const many = Array.from({ length: 60 }, (_, i) => door(`thing.a${i}`));
    const map = tier0Map(many, 'bot');
    const left = 60 - map.carried.length;
    expect(left).toBeGreaterThan(0);
    expect(map.text.split('\n').at(-1)).toBe(moreLine(left));
    expect(map.text.length).toBeLessThanOrEqual(TIER0_MAP_MAX_CHARS);
  });

  it('merges a family into its tools with their counts before it leaves any card out', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      door(`thing${i % 3}.a_long_act_name_${i}`, 'issue-work'),
    );
    const map = tier0Map([...many, door('other.c')], 'bot');
    expect(map.carried.length).toBe(121);
    expect(map.text.length).toBeLessThanOrEqual(TIER0_MAP_MAX_CHARS);
    expect(map.text.split('\n')).toEqual([
      '- when you need other.c → other.c',
      '- when a second case → other.c',
      `- when ${CARD_FAMILIES['issue-work']} → thing0.* (40) · thing1.* (40) · thing2.* (40)`,
      mergedLine,
    ]);
    // a family that fits is still named act by act
    expect(tier0Map(many.slice(0, 2), 'bot').text).toBe(
      `- when ${CARD_FAMILIES['issue-work']} → thing0.a_long_act_name_0 · thing1.a_long_act_name_1`,
    );
  });

  it('names each REST door by its module and act, every name one door', () => {
    const doors = servedDoorCatalog().doors;
    const names = doorNames(doors);
    const of = (id: string) => names.get(id);
    expect(of('POST /api/issues/:id/merge')).toBe('issues.merge');
    expect(of('PUT /api/issues/:id/criteria')).toBe('issues.set_criteria');
    expect(of('POST /api/projects/:id/requirements/:req/comments')).toBe('comments.requirements');
    expect(of('POST /api/projects/:id/requirements/:req/revisions/:n/accept')).toBe(
      'requirements.revisions_accept',
    );
    expect(of('POST /api/memory/:memoryId/retire')).toBe('memory.retire_one');
    expect(of('POST /api/memory/retire')).toBe('memory.retire');
    const carded = doors.filter((d) => d.card).map((d) => names.get(d.id));
    expect(carded.filter((n, i) => carded.indexOf(n) !== i)).toEqual([]);
  });

  it('gives every card a family, so none takes lines of its own on any map', () => {
    const loose = servedDoorCatalog()
      .doors.filter((d) => d.card && !d.card.family)
      .map((d) => d.id);
    expect(loose).toEqual([]);
  });
});

// ISS-1251 c1: every door an agent reaches for carries one card, with the wrong way it was used and
// a worked call; a REST write no agent reaches for is declared with why (`uncarded-doors.ts`)
describe('every agent-facing door is carded whole', () => {
  const doors = servedDoorCatalog().doors;
  const declared = Object.values(UNCARDED_DOORS).flat();

  it('cards every MCP action, and every REST write it does not declare', () => {
    const bare = doors
      .filter((d) => !d.card && (d.surface === 'mcp' || !declared.includes(d.id)))
      .map((d) => `${d.surface} ${d.id}`);
    expect(bare, 'carry a card beside the door, or declare it in mcp/uncarded-doors.ts').toEqual(
      [],
    );
  });

  it('declares only served REST writes that carry no card, each once', () => {
    const served = new Map(doors.map((d) => [d.id, d]));
    const wrong = declared.filter(
      (id, i) =>
        declared.indexOf(id) !== i || served.get(id)?.surface !== 'rest' || served.get(id)?.card,
    );
    expect(wrong, 'a declared door that is carded, twinned, gone or declared twice').toEqual([]);
  });

  it('gives every card a red flag, a worked example and a scenario, naming the card that lacks one', () => {
    // ISS-1251 c1: on dev.709, 60 of 343 cards carried no scenario, so nothing replayed their teaching
    const thin = doors
      .filter(
        (d) =>
          d.card &&
          (!d.card.redFlag || d.card.example === undefined || d.card.scenarios.length === 0),
      )
      .map(
        (d) =>
          `${d.id}${d.card?.redFlag ? '' : ' redFlag'}${d.card?.example === undefined ? ' example' : ''}${d.card?.scenarios.length ? '' : ' scenarios'}`,
      );
    expect(thin).toEqual([]);
  });
});

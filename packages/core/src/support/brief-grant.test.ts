// REQ-90 BC-11: a room's persona and its grants cannot state two rules for who agrees to one act.
// @direct-test-of packages/core/src/support/brief-grant.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

const rulings = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../knowledge/index.js', () => ({ rulingDecidersOf: rulings.read }));

import { briefGrantRefusals } from './brief-grant.js';

// FB-566's brief, as the owner rewrote it on 2026-11-07
const FB_566 =
  'A request for work from anyone in the room is yours: when it is clear, record it at once, and never end with if chuongld agrees.';
const ruling = (member: string, acts: string[]) => ({
  member,
  acts,
  ruling: 'who-files',
  title: 'Who files',
  updatedAt: new Date(),
});

const check = (persona: string, grants?: { abilities: never[]; confirmers?: string[] }) =>
  briefGrantRefusals({
    projectId: 'p-1',
    at: '/agent',
    block: { persona, ...(grants ? { grants } : {}) },
  });

beforeEach(() => rulings.read.mockResolvedValue([]));

describe('a persona and the grants on who agrees to one act (BC-11)', () => {
  it('refuses the FB-566 brief while no ruling lets any member agree to a filing, naming both and the act', async () => {
    const refused = await check(FB_566);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.path).toBe('/agent/persona');
    expect(refused[0]?.detail).toContain(
      'the persona says any member of the room agrees to recording work (a filing)',
    );
    expect(refused[0]?.detail).toContain('the grants and the project');
  });

  it.each([
    ['a ruling lets any member file', FB_566, [ruling('*', ['filing'])], undefined],
    [
      'a persona saying nothing of who agrees',
      'You answer customers of the shop in plain Vietnamese.',
      [],
      undefined,
    ],
    [
      'only a named confirmer deploys, as the grant names',
      'Only @tuyen confirms a deploy.',
      [],
      ['tuyen'],
    ],
  ] as const)('accepts it where %s', async (_, persona, named, confirmers) => {
    rulings.read.mockResolvedValue(named);
    const grants = confirmers
      ? { abilities: [] as never[], confirmers: [...confirmers] }
      : undefined;
    expect(await check(persona, grants)).toEqual([]);
  });

  it('refuses "only @x" where the grant names another confirmer', async () => {
    const refused = await check('Only @tuyen confirms a deploy.', {
      abilities: [],
      confirmers: ['minh'],
    });
    expect(refused[0]?.detail).toContain('only @tuyen agrees to a deploy');
    expect(refused[0]?.detail).toContain('@minh (grants.confirmers)');
  });
});

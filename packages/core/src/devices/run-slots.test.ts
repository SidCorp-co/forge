import { describe, expect, it } from 'vitest';
import { LENT_RUN_CEILING, lendFor, type SlotDemand, slotsFor } from './run-slots.js';

const p = (projectId: string, wants: number, urgent = false): SlotDemand => ({
  projectId,
  wants,
  urgent,
});
const asObject = (m: Map<string, number>) => Object.fromEntries(m);

describe('slotsFor', () => {
  it('gives a lone project with work every slot it can use, and no more', () => {
    expect(asObject(slotsFor([p('a', 3)], 6))).toEqual({ a: 3 });
    expect(asObject(slotsFor([p('a', 9)], 6))).toEqual({ a: 6 });
  });

  it('holds a project with no work at 0 and one with work at 1 at least', () => {
    expect(asObject(slotsFor([p('a', 0), p('b', 1)], 4))).toEqual({ a: 0, b: 1 });
    expect(asObject(slotsFor([p('a', 5), p('b', 5)], 2))).toEqual({ a: 1, b: 1 });
  });

  it('grows the box to the floor count when projects with work outnumber it', () => {
    const slots = slotsFor([p('a', 2), p('b', 1), p('c', 4, true)], 2);
    expect(asObject(slots)).toEqual({ a: 1, b: 1, c: 1 });
    expect(asObject(slotsFor([p('a', 1)], 0))).toEqual({ a: 1 });
  });

  it('shares the free slots one at a time, round-robin, to projects that can use them', () => {
    expect(asObject(slotsFor([p('a', 5), p('b', 5)], 6))).toEqual({ a: 3, b: 3 });
    expect(asObject(slotsFor([p('a', 5), p('b', 5)], 5))).toEqual({ a: 3, b: 2 });
    // what a project cannot use goes to the one that can
    expect(asObject(slotsFor([p('a', 1), p('b', 9)], 6))).toEqual({ a: 1, b: 5 });
  });

  it('serves every urgent project before a normal one takes a free slot', () => {
    expect(asObject(slotsFor([p('a', 5), p('b', 3, true)], 5))).toEqual({ a: 2, b: 3 });
    expect(asObject(slotsFor([p('a', 5), p('b', 9, true)], 5))).toEqual({ a: 1, b: 4 });
  });

  it('gives a busy project idle slots and takes them back for a project that gets work', () => {
    const idle = slotsFor([p('a', 6), p('b', 0)], 6);
    expect(asObject(idle)).toEqual({ a: 6, b: 0 });
    // b gets work: it holds its floor at once, and a is held to its share (its live runs go on)
    const busy = slotsFor([p('a', 6), p('b', 2)], 6);
    expect(asObject(busy)).toEqual({ a: 4, b: 2 });
  });

  it('refuses a count that is not a whole number, and a project listed twice', () => {
    expect(() => slotsFor([p('a', 1)], -1)).toThrow(/capacity must be a whole number/);
    expect(() => slotsFor([p('a', 1.5)], 2)).toThrow(/wants of a/);
    expect(() => slotsFor([p('a', 1), p('a', 2)], 2)).toThrow(/listed twice/);
  });
});

// ISS-1420: one run past the slots for a critical or high declaration, within the token-budget count
describe('lendFor', () => {
  const room = {
    memory: { availableMb: 9000, reserveMb: 1000 },
    cpu: { pressureSomeAvg10: 4, ceiling: 40 },
  };
  const health = {
    ...room,
    disk: { freeMb: 9000, reserveMb: 1000 },
    kvm: true,
    modes: [],
    held: [],
  };
  const ask = (inUse: number, slots: number, priority = 'critical') => ({
    slots,
    inUse,
    issues: [{ key: 'ISS-9', priority }],
    health,
  });

  it('never lends past the most runs urgent work takes, nor for normal work', () => {
    expect(lendFor(ask(LENT_RUN_CEILING - 1, LENT_RUN_CEILING - 1)).lent).toBe(true);
    const capped = lendFor(ask(LENT_RUN_CEILING, LENT_RUN_CEILING));
    expect(capped).toEqual({
      lent: false,
      why: expect.stringContaining('is the most urgent work takes'),
    });
    expect(lendFor(ask(1, 1, 'medium')).why).toContain(
      'none of the declared issues is critical or high',
    );
  });
});

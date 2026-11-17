import type { BoxCost, BoxHealthReport } from '@forge/contracts/box-wire';
import type { BoxMode } from '@forge/contracts/boxes';
import { describe, expect, it } from 'vitest';
import { type BoxAsk, type BoxRoom, type SlotDemand, slotsFor } from './run-slots.js';

// Forge Boxes ride the slot rule (ISS-1276): capacity is the device's measured health against each
// mode's cost, never a count.

const COST: Record<BoxMode, BoxCost> = {
  android: { memoryMb: 4096, diskMb: 512, cpuCores: 3 },
  browser: { memoryMb: 600, diskMb: 100, cpuCores: 1 },
  desktop: { memoryMb: 800, diskMb: 100, cpuCores: 1 },
};
const GB = 1024;

function health(availableGb: number, pressure = 5): BoxHealthReport {
  return {
    memory: { availableMb: availableGb * GB, reserveMb: 16 * GB },
    cpu: { pressureSomeAvg10: pressure, ceiling: 40 },
    disk: { freeMb: 500 * GB, reserveMb: 20 * GB },
    kvm: true,
    modes: [],
    held: [],
  };
}

const ask = (boxId: string, mode: BoxMode): BoxAsk => ({ boxId, mode, cost: COST[mode] });
const project = (projectId: string, boxes: BoxAsk[], urgent = false): SlotDemand => ({
  projectId,
  wants: 0,
  urgent,
  boxes,
});
const room = (h: BoxRoom['health'], over: Partial<BoxRoom> = {}): BoxRoom => ({
  health: h,
  committed: { memoryMb: 0, diskMb: 0, cpuCores: 0 },
  held: new Map(),
  warmWanted: [],
  ...over,
});

describe('slotsFor, with box demand', () => {
  it('runs or waits 8 mixed requests by health, none refused by a number', () => {
    // 30 GB available, 16 GB reserve: 14 GB of room for 4 android (4 GB) and 4 browser (0.6 GB)
    const asks = [
      project('a', [
        ask('a1', 'android'),
        ask('a2', 'android'),
        ask('a3', 'browser'),
        ask('a4', 'browser'),
      ]),
      project('b', [
        ask('b1', 'android'),
        ask('b2', 'android'),
        ask('b3', 'browser'),
        ask('b4', 'browser'),
      ]),
    ];
    const plan = slotsFor(asks, 0, room(health(30))).boxes;
    expect(plan.start.length + plan.wait.size).toBe(8);
    expect(plan.start.length).toBeGreaterThan(0);
    for (const place of plan.wait.values()) {
      expect(place.reason).toMatch(/available memory .* leaves .*; a (android|browser) box costs/);
      expect(place.reason).not.toMatch(/maximum|limit of \d+ boxes/);
    }
    // the same 8 on a roomier device all start: no count held any back
    expect(slotsFor(asks, 0, room(health(120))).boxes.start).toHaveLength(8);
  });

  it('holds a request over the headroom waiting, naming why, and starts it when headroom returns', () => {
    const asks = [project('a', [ask('a1', 'browser')])];
    const pressed = slotsFor(asks, 0, room(health(60, 85))).boxes;
    expect(pressed.start).toEqual([]);
    expect(pressed.wait.get('a1')).toEqual({
      position: 1,
      reason: 'CPU pressure is 85% (PSI some avg10), over the 40% ceiling',
    });
    expect(slotsFor(asks, 0, room(health(60, 12))).boxes.start).toEqual(['a1']);
  });

  it('waits on a device whose health is not measured, saying so', () => {
    const plan = slotsFor(
      [project('a', [ask('a1', 'browser')])],
      0,
      room({ unmeasured: 'stale' }),
    ).boxes;
    expect(plan.wait.get('a1')?.reason).toBe('stale');
  });

  it("gives every project its first box before any project's second, the urgent first", () => {
    // room for two android boxes: a holds one already, so b and c (urgent first) go before a's next
    const asks = [
      project('a', [ask('a2', 'android')]),
      project('b', [ask('b1', 'android')]),
      project('c', [ask('c1', 'android')], true),
    ];
    const plan = slotsFor(asks, 0, room(health(16 + 9), { held: new Map([['a', 1]]) })).boxes;
    expect(plan.start).toEqual(['c1', 'b1']);
    expect(plan.wait.get('a2')?.position).toBe(1);
  });

  it('counts the boxes started since the measurement against it', () => {
    const asks = [project('a', [ask('a1', 'android')])];
    const committed = { memoryMb: 4 * GB, diskMb: 0, cpuCores: 0 };
    expect(slotsFor(asks, 0, room(health(22))).boxes.start).toEqual(['a1']);
    expect(slotsFor(asks, 0, room(health(22), { committed })).boxes.start).toEqual([]);
  });

  it('keeps one warm box per served mode, never taking room a waiting request needs', () => {
    const warm = [{ mode: 'browser' as const, cost: COST.browser }];
    expect(slotsFor([], 0, room(health(40), { warmWanted: warm })).boxes.warm).toEqual(['browser']);
    const waiting = [project('a', [ask('a1', 'android')])];
    expect(slotsFor(waiting, 0, room(health(19), { warmWanted: warm })).boxes).toMatchObject({
      start: [],
      warm: [],
    });
  });

  it('leaves the subagent answer as it was', () => {
    const slots = slotsFor([{ projectId: 'a', wants: 3, urgent: false }], 6);
    expect(Object.fromEntries(slots)).toEqual({ a: 3 });
    expect(slots.boxes).toEqual({ start: [], warm: [], wait: new Map() });
  });
});

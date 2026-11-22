/**
 * How many subagents each project on one box may run at once (ISS-1245). The ONE place a slot
 * count is computed: `scripts/check-run-slots.mjs` refuses one anywhere else.
 *
 * A slot is not a row. A live slot IS an open run session, so a claim is `run declare` and a
 * release is the run's close; this file only answers how many a project may hold.
 *
 * The rule, in full:
 * - every project with work holds 1 slot, always, and the box grows to that count when projects
 *   with work outnumber it;
 * - the slots left go one at a time, round-robin, to projects that can use more, the urgent
 *   (a ready critical or high issue) all served before the rest;
 * - a project never holds more than it can use.
 *
 * Give-back needs no code: when another project gets work the next answer gives it its floor, a
 * project then over its share is refused its next start at the door, and nothing running stops.
 *
 * One run past the slots is lent (ISS-1420, `lendFor`) to a declaration over a critical or high issue
 * while the box's last health measurement has room: a master whose slots a long build holds then
 * dispatches its urgent fix instead of building it in its own pane. The lend takes no other project's
 * slot, so it runs beside the count, never inside it:
 * - one lent run at a time per project, and never past `LENT_RUN_CEILING` runs in use;
 * - past the box's limit (its CPU pressure ceiling, memory or disk reserve, or no fresh measurement)
 *   it is refused, and the refusal names why.
 *
 * Forge Boxes ride the same rule (ISS-1276, ADR 0015), as `room`: no second counter, and no count of
 * boxes at all. A box's capacity is what the device's last health measurement leaves, after its
 * reserve and the boxes started since that measurement, against what the box's mode costs:
 * - a project's first box goes before any project's second (its floor), then round-robin by fewest
 *   held, the urgent first among equals;
 * - a request that does not fit waits, with its place and the health reason, and a cheaper one
 *   behind it may still start;
 * - each served mode keeps one warm box, given room once every request started and none waits.
 */

import type { BoxCost, BoxHealthReport } from '@forge/contracts/box-wire';
import type { BoxMode, BoxQueuePlace } from '@forge/contracts/boxes';

export interface SlotDemand {
  projectId: string;
  /** Subagents it could run at once: those it runs now plus the ready parts nobody has started. */
  wants: number;
  /** Whether a ready part of it is critical or high. */
  urgent: boolean;
  /** Its waiting box requests, oldest first. */
  boxes?: readonly BoxAsk[];
}

/** One waiting box request and what its mode costs on this device. */
export interface BoxAsk {
  boxId: string;
  mode: BoxMode;
  cost: BoxCost;
}

/** What the device holds and measured, for its box requests. */
export interface BoxRoom {
  /** The latest health, or why there is none to trust (never reported, or older than fresh). */
  health: BoxHealthReport | { unmeasured: string };
  /** The cost of boxes told to start since that measurement, which it cannot have seen. */
  committed: BoxCost;
  /** Each project's boxes running or opening now. */
  held: ReadonlyMap<string, number>;
  /** Served modes holding no warm box, with their cost. */
  warmWanted: readonly { mode: BoxMode; cost: BoxCost }[];
}

/** Which waiting boxes start now, which warm boxes to open, and where each one left waits. */
export interface BoxPlan {
  start: string[];
  warm: BoxMode[];
  wait: Map<string, BoxQueuePlace>;
}

export type SlotAnswer = Map<string, number> & { boxes: BoxPlan };

/** The priorities a ready part counts as urgent for: the slot rule's tier and the lend. */
export const URGENT_PRIORITIES: ReadonlySet<string> = new Set(['critical', 'high']);

/** The most runs a project holds at once with one lent: the `token-budget` rule's count for urgent work. */
export const LENT_RUN_CEILING = 5;

/** A declaration refused a slot, asking for one run past its project's slots (ISS-1420). */
export interface LendAsk {
  /** What `slotsFor` gives the project on this box now, and its runs holding one. */
  slots: number;
  inUse: number;
  /** The declaration's issues by key, each with its priority. */
  issues: readonly { key: string; priority: string | null }[];
  /** The box's last health, or why there is none to trust (`box-health.ts:freshBoxHealth`). */
  health: BoxHealthReport | { unmeasured: string };
}

/** Whether one run past the slots is lent, and why it is or is not, in words a master reads. */
export interface Lend {
  lent: boolean;
  why: string;
}

function wholeCount(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`slotsFor: ${what} must be a whole number of at least 0, got ${n}`);
  }
}

/**
 * Each project's slots on a box of `capacity`; a project with no work holds 0. With `room`, its
 * `boxes` places every waiting box request too.
 */
export function slotsFor(
  projects: readonly SlotDemand[],
  capacity: number,
  room?: BoxRoom,
): SlotAnswer {
  wholeCount(capacity, 'capacity');
  const slots = new Map<string, number>();
  for (const p of projects) {
    wholeCount(p.wants, `wants of ${p.projectId}`);
    if (slots.has(p.projectId)) throw new RangeError(`slotsFor: ${p.projectId} is listed twice`);
    slots.set(p.projectId, p.wants > 0 ? 1 : 0);
  }
  const withWork = projects.filter((p) => p.wants > 0);
  let free = Math.max(capacity, withWork.length) - withWork.length;
  const byId = (a: SlotDemand, b: SlotDemand) => (a.projectId < b.projectId ? -1 : 1);
  for (const tier of [withWork.filter((p) => p.urgent), withWork.filter((p) => !p.urgent)]) {
    const order = [...tier].sort(byId);
    let gave = true;
    while (free > 0 && gave) {
      gave = false;
      for (const p of order) {
        const held = slots.get(p.projectId) ?? 0;
        if (free === 0 || held >= p.wants) continue;
        slots.set(p.projectId, held + 1);
        free -= 1;
        gave = true;
      }
    }
  }
  const boxes = room ? placeBoxes(projects, room) : { start: [], warm: [], wait: new Map() };
  return Object.assign(slots, { boxes });
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

const cpuOver = (h: BoxHealthReport): string | null =>
  h.cpu.pressureSomeAvg10 > h.cpu.ceiling
    ? `CPU pressure is ${h.cpu.pressureSomeAvg10}% (PSI some avg10), over the ${h.cpu.ceiling}% ceiling`
    : null;

/**
 * One run past the project's slots for a critical or high declaration while the box has room, or why
 * none is lent. Asked only once every slot the project holds is in use.
 */
export function lendFor(ask: LendAsk): Lend {
  wholeCount(ask.slots, 'slots');
  wholeCount(ask.inUse, 'inUse');
  const urgent = ask.issues.filter((i) => URGENT_PRIORITIES.has(i.priority ?? ''));
  if (urgent.length === 0) {
    return {
      lent: false,
      why: 'no run is lent past them: none of the declared issues is critical or high',
    };
  }
  if (ask.inUse > ask.slots) {
    return { lent: false, why: 'no run is lent past them: the project already runs past them' };
  }
  if (ask.inUse >= LENT_RUN_CEILING) {
    return {
      lent: false,
      why: `no run is lent past them: ${ask.inUse} run(s) in use, and ${LENT_RUN_CEILING} is the most urgent work takes`,
    };
  }
  const h = ask.health;
  const full =
    'unmeasured' in h
      ? h.unmeasured
      : (cpuOver(h) ??
        (h.memory.availableMb <= h.memory.reserveMb
          ? `available memory ${gb(h.memory.availableMb)} is within the ${gb(h.memory.reserveMb)} reserve`
          : h.disk.freeMb <= h.disk.reserveMb
            ? `free disk ${gb(h.disk.freeMb)} is within the ${gb(h.disk.reserveMb)} reserve`
            : null));
  if (full !== null || 'unmeasured' in h) {
    return { lent: false, why: `no run is lent past them: ${full}` };
  }
  const named = urgent.map((i) => `${i.key} (${i.priority})`).join(', ');
  return {
    lent: true,
    why:
      `lent one run past the project's ${ask.slots} slot(s) for ${named}: the box has room ` +
      `(CPU pressure ${h.cpu.pressureSomeAvg10}% of a ${h.cpu.ceiling}% ceiling)`,
  };
}

/** Why a box of `cost` does not start now, or null where it fits. */
function noRoom(room: BoxRoom, used: BoxCost, mode: BoxMode, cost: BoxCost): string | null {
  const h = room.health;
  if ('unmeasured' in h) return h.unmeasured;
  const cpu = cpuOver(h);
  if (cpu !== null) return cpu;
  const memory = h.memory.availableMb - h.memory.reserveMb - used.memoryMb;
  if (cost.memoryMb > memory) {
    return `available memory ${gb(h.memory.availableMb)} less the ${gb(h.memory.reserveMb)} reserve and ${gb(used.memoryMb)} for boxes starting leaves ${gb(Math.max(0, memory))}; a ${mode} box costs ${gb(cost.memoryMb)}`;
  }
  const disk = h.disk.freeMb - h.disk.reserveMb - used.diskMb;
  if (cost.diskMb > disk) {
    return `free disk ${gb(h.disk.freeMb)} less the ${gb(h.disk.reserveMb)} reserve and ${gb(used.diskMb)} for boxes starting leaves ${gb(Math.max(0, disk))}; a ${mode} box costs ${gb(cost.diskMb)}`;
  }
  return null;
}

/** The waiting requests in the order they are served: fewest held first, urgent first among equals. */
function serveOrder(projects: readonly SlotDemand[], room: BoxRoom): BoxAsk[] {
  const queues = projects
    .filter((p) => (p.boxes?.length ?? 0) > 0)
    .map((p) => ({ p, next: 0, held: room.held.get(p.projectId) ?? 0 }));
  const order: BoxAsk[] = [];
  for (;;) {
    const open = queues.filter((q) => q.next < (q.p.boxes?.length ?? 0));
    if (open.length === 0) return order;
    open.sort(
      (a, b) =>
        a.held - b.held ||
        Number(b.p.urgent) - Number(a.p.urgent) ||
        (a.p.projectId < b.p.projectId ? -1 : 1),
    );
    const q = open[0] as (typeof open)[number];
    order.push((q.p.boxes as readonly BoxAsk[])[q.next] as BoxAsk);
    q.next += 1;
    q.held += 1;
  }
}

function placeBoxes(projects: readonly SlotDemand[], room: BoxRoom): BoxPlan {
  const used = { ...room.committed };
  const take = (cost: BoxCost) => {
    used.memoryMb += cost.memoryMb;
    used.diskMb += cost.diskMb;
    used.cpuCores += cost.cpuCores;
  };
  const plan: BoxPlan = { start: [], warm: [], wait: new Map() };
  for (const ask of serveOrder(projects, room)) {
    const why = noRoom(room, used, ask.mode, ask.cost);
    if (why === null) {
      plan.start.push(ask.boxId);
      take(ask.cost);
    } else plan.wait.set(ask.boxId, { position: plan.wait.size + 1, reason: why });
  }
  // a warm box never takes room a waiting request could have had
  for (const w of plan.wait.size > 0 ? [] : room.warmWanted) {
    if (noRoom(room, used, w.mode, w.cost) !== null) continue;
    plan.warm.push(w.mode);
    take(w.cost);
  }
  return plan;
}

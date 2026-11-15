/**
 * How many subagents each project on one box may run at once (ISS-1245). The ONE place a slot
 * count is computed: `scripts/check-run-slots-fence.mjs` refuses one anywhere else.
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
 */

export interface SlotDemand {
  projectId: string;
  /** Subagents it could run at once: those it runs now plus the ready parts nobody has started. */
  wants: number;
  /** Whether a ready part of it is critical or high. */
  urgent: boolean;
}

function wholeCount(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`slotsFor: ${what} must be a whole number of at least 0, got ${n}`);
  }
}

/** Each project's slots on a box of `capacity`; a project with no work holds 0. */
export function slotsFor(projects: readonly SlotDemand[], capacity: number): Map<string, number> {
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
  return slots;
}

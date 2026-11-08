/**
 * One ask on a project's read's way: the `n`th time it asks `key`. Two projects' reads that differ in
 * shape reach a key at different quiet points, and some ask it again further on, so the order the
 * code asks in is learned per step, not per key.
 */
export const stepOf = (key: string, n: number) => `${key}\u0003${n}`;

/** Whether `step` is an ask of `key`. */
export const isStepOf = (step: string, key: string) => step.startsWith(`${key}\u0003`);

/** One ask a project's read made: its step and the quiet point it was made at. */
export interface Made {
  step: string;
  at: number;
}

/**
 * The way one project's read of one read across projects (`db/read-memo.ts:readAcross`, by its name)
 * went the last time it ran: the quiet point each step was asked at, and those of each key's asks in
 * turn. It names reads, steps and counts, never ids, so it holds no answer and no project's data,
 * only how the code went for that project.
 *
 * It is one project's own, not one order every project's read shares (ISS-1070 r15): a shared order
 * said every read waiting on a step asks each key any other kind of project asked after it, so a
 * batch was held for an empty project, an outside-git project or a storefront that never asks it;
 * once every batch was held so, the least held was read first and the projects a step behind asked
 * it again. forge-dev's fourteen projects of mixed kinds sent a statement four to six times a read.
 */
export interface Path {
  /** The quiet point each step was first asked at. */
  stepAt: Map<string, number>;
  /** The quiet points of each key's asks, the first ask's first. */
  asksOf: Map<string, number[]>;
}

/** How many projects' paths are kept at most, the longest unread dropped first. */
const KEPT = 4_000;
const paths = new Map<string, Path>();

const pathKey = (name: string, project: string) => `${name}\u0004${project}`;

/** The way the read named `name` last went for `project`; undefined before it has run once. */
export function pathOf(name: string, project: string): Path | undefined {
  const key = pathKey(name, project);
  const path = paths.get(key);
  if (path) {
    // read now: kept as the newest
    paths.delete(key);
    paths.set(key, path);
  }
  return path;
}

/**
 * Keeps the way one project's read went, from the asks it made: the next read of that project
 * holds a batch only for what this one asked after the steps it waits on. A read that asked nothing
 * across projects (one project's, which reads each ask as it comes) teaches nothing.
 */
export function learnPath(name: string, project: string, made: readonly Made[]): void {
  if (made.length === 0) return;
  const stepAt = new Map<string, number>();
  const asksOf = new Map<string, number[]>();
  for (const { step, at } of made) {
    if (!stepAt.has(step)) stepAt.set(step, at);
    const key = step.slice(0, step.lastIndexOf('\u0003'));
    const asks = asksOf.get(key);
    if (asks) asks.push(at);
    else asksOf.set(key, [at]);
  }
  const key = pathKey(name, project);
  paths.delete(key);
  paths.set(key, { stepAt, asksOf });
  if (paths.size > KEPT) paths.delete(paths.keys().next().value as string);
}

/**
 * Whether a project's read waiting on `waits`, having asked `key` `made` times, asks it again after
 * them, as its own last read went: `yes` where that read asked it again at a later quiet point than
 * one of them, `no` where it did not, `unknown` where the project has no path yet or waits on a step
 * its last read never took.
 */
export function mayAsk(
  path: Path | undefined,
  waits: Iterable<string>,
  key: string,
  made: number,
): 'yes' | 'no' | 'unknown' {
  if (!path) return 'unknown';
  const later = path.asksOf.get(key)?.slice(made) ?? [];
  if (later.length === 0) return 'no';
  // a read waiting on no step of its own waits on another's answer, and goes on from it
  let known = false;
  let unread = false;
  for (const w of waits) {
    known = true;
    const at = path.stepAt.get(w);
    if (at === undefined) unread = true;
    else if (later.some((a) => a > at)) return 'yes';
  }
  return known && !unread ? 'no' : 'unknown';
}

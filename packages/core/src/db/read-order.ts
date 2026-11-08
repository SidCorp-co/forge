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
 * The order one read across projects (`db/read-memo.ts:readAcross`, by its name) asks in, learned
 * from the project reads it has run: the steps a project's read asked at a later quiet point than
 * each step, and the most times any asked each key. It names reads and counts, never ids, so it holds
 * no answer and no project's data, only how the code is laid out. It learns while the order still
 * changes, and again every {@link RELEARN}th read, so a new shape is learned without each read paying
 * for it (ISS-1070 r9).
 */
export interface Order {
  after: Map<string, Set<string>>;
  most: Map<string, number>;
  /** Reads in a row that left the order unchanged, and reads in all. */
  steady: number;
  reads: number;
}

/** How many reads in a row leave the order unchanged before it stops being learned on every read. */
const STEADY = 3;
const RELEARN = 50;
const orders = new Map<string, Order>();

/** The order of the read named `name`. */
export function orderOf(name: string): Order {
  let order = orders.get(name);
  if (!order) {
    order = { after: new Map(), most: new Map(), steady: 0, reads: 0 };
    orders.set(name, order);
  }
  return order;
}

/** Counts a read of `order` begun; answers whether this read learns from its project reads. */
export function begun(order: Order): boolean {
  order.reads += 1;
  return order.steady < STEADY || order.reads % RELEARN === 0;
}

/** Learns from the asks of each project read of a read that has ended. */
export function learned(
  order: Order,
  reads: readonly { asks: Map<string, number>; made: Made[] }[],
) {
  const changed = reads.map((r) => learnFrom(order, r.asks, r.made)).some(Boolean);
  order.steady = changed ? 0 : order.steady + 1;
}

/** Learns the order one project's read asked in; answers whether it added to it. */
function learnFrom(order: Order, asks: Map<string, number>, made: readonly Made[]): boolean {
  const { after, most } = order;
  let changed = false;
  for (const [key, n] of asks)
    if (n > (most.get(key) ?? 0)) {
      most.set(key, n);
      changed = true;
    }
  // every step asked at an earlier quiet point comes before each step asked at a later one
  for (let i = 0, from = 0; i < made.length; i++) {
    const { step, at } = made[i] as Made;
    while (from < i && (made[from] as Made).at < at) from++;
    for (let j = 0; j < from; j++) {
      const earlier = (made[j] as Made).step;
      let next = after.get(earlier);
      if (!next) {
        next = new Set();
        after.set(earlier, next);
      }
      if (!next.has(step)) {
        next.add(step);
        changed = true;
      }
    }
  }
  return changed;
}

/** Whether a read waiting on `waits` has been seen to ask `key` after them, having asked it `made` times. */
export function mayAsk(order: Order, waits: Iterable<string>, key: string, made: number): boolean {
  const most = order.most.get(key) ?? 0;
  if (most <= made) return false;
  for (const w of waits) {
    const next = order.after.get(w);
    if (next) for (let n = made + 1; n <= most; n++) if (next.has(stepOf(key, n))) return true;
  }
  return false;
}

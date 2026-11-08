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
 * no answer and no project's data, only how the code is laid out. It learns from its first reads
 * until the order holds unchanged or {@link LEARNING} have taught it (two projects' reads side by side
 * never ask in quite the same order, so it can grow a little on every read), and again every
 * {@link RELEARN}th read, so a new shape is learned without each read paying for it (ISS-1070 r9:
 * learning on every read cost the home 28 ms of its 12 projects).
 */
export interface Order {
  after: Map<string, Set<string>>;
  most: Map<string, number>;
  /** Reads in a row that left the order unchanged, reads that taught it, and reads in all. */
  steady: number;
  taught: number;
  reads: number;
}

/** How many reads in a row leave the order unchanged before it stops being learned on every read. */
const STEADY = 3;
/** How many reads teach the order at most before it is learned only every {@link RELEARN}th read. */
const LEARNING = 8;
const RELEARN = 50;
const orders = new Map<string, Order>();

/** The order of the read named `name`. */
export function orderOf(name: string): Order {
  let order = orders.get(name);
  if (!order) {
    order = { after: new Map(), most: new Map(), steady: 0, taught: 0, reads: 0 };
    orders.set(name, order);
  }
  return order;
}

/** Counts a read of `order` begun; answers whether this read learns from its project reads. */
export function begun(order: Order): boolean {
  order.reads += 1;
  return (order.steady < STEADY && order.taught < LEARNING) || order.reads % RELEARN === 0;
}

/** Learns from the asks of each project read of a read that has ended. */
export function learned(
  order: Order,
  reads: readonly { asks: Map<string, number>; made: Made[] }[],
) {
  // a read that asked nothing across projects (one project's, which reads each ask as it comes) teaches nothing
  if (reads.every((r) => r.made.length === 0)) return;
  order.taught += 1;
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

/**
 * Whether a read waiting on `waits`, having asked `key` `made` times, asks it again after them, as
 * its read's order has learned: `yes` where a later read asked it after one of them, `no` where the
 * order knows what follows each and it is not there, `unknown` where it knows nothing of one.
 */
export function mayAsk(
  order: Order,
  waits: Iterable<string>,
  key: string,
  made: number,
): 'yes' | 'no' | 'unknown' {
  const most = order.most.get(key) ?? 0;
  let known = most > 0;
  for (const w of waits) {
    const next = order.after.get(w);
    if (!next) known = false;
    else for (let n = made + 1; n <= most; n++) if (next.has(stepOf(key, n))) return 'yes';
  }
  return known ? 'no' : 'unknown';
}

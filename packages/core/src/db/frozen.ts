/**
 * A value made read-only down to its rows, so one answer can be handed to every reader of a request
 * (`db/read-memo.ts`) instead of a copy to each: a reader that writes into what it was handed throws
 * where it writes, naming the property, rather than changing another reader's answer. Objects and
 * arrays are frozen; a Map or Set keeps its entries and refuses `set`, `add`, `delete` and `clear`.
 * A typed array or buffer cannot be frozen and is left as it is; nothing a read answers holds one.
 *
 * It goes {@link ROW_DEPTH} levels deep: the answer, the container it holds its rows in, and each
 * row. What a row holds below that (a verdict's evidence, a run's steps, a design's document: the
 * jsonb a statement parsed) is left writable, an accepted gap priced in ISS-1070 r6: frozen through
 * and through, a person's twelve projects froze over a hundred thousand objects a read, 405 ms of
 * its time, more than the copy per ask this replaced. A reader that sorts or pushes into such a
 * nested value in place changes it for every reader of the request; none in the suite does, and a
 * reader that must reorder one copies it first.
 */

const refuse = (what: string) => () => {
  throw new TypeError(`${what} is a read answer shared across a request and cannot change`);
};

/** The answer, its container and each row: the levels made read-only. */
const ROW_DEPTH = 3;

export function frozen<T>(value: T): T {
  freeze(value, 0);
  return value;
}

/**
 * A value already frozen is not walked again: what it holds was made read-only before it, so a
 * batch's rows handed on to every reader are walked once. No register of what was walked is kept
 * (ISS-1070 r11: a WeakSet entry and an `Object.values` copy an object cost a person's twelve
 * projects 150 ms of a read, and their collection more); a frozen object says so itself. A Date is
 * left as it is: freezing one never stopped `setTime`, which writes its own slot, and a read
 * answers thousands.
 */
function freeze(value: unknown, depth: number): void {
  if (depth >= ROW_DEPTH || value === null || typeof value !== 'object' || Object.isFrozen(value))
    return;
  if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
  const below = depth + 1;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) freeze(value[i], below);
  } else if (value instanceof Map) {
    for (const [k, v] of value) {
      freeze(k, below);
      freeze(v, below);
    }
    for (const m of ['set', 'delete', 'clear'])
      Object.defineProperty(value, m, { value: refuse(`Map.${m}`) });
  } else if (value instanceof Set) {
    for (const v of value) freeze(v, below);
    for (const m of ['add', 'delete', 'clear'])
      Object.defineProperty(value, m, { value: refuse(`Set.${m}`) });
  } else {
    for (const k in value) freeze((value as Record<string, unknown>)[k], below);
  }
  Object.freeze(value);
}

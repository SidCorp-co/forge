/**
 * A value made read-only through and through, so one answer can be handed to every reader of a
 * request (`db/read-memo.ts`) instead of a copy to each: a reader that writes into what it was
 * handed throws where it writes, naming the property, rather than changing another reader's answer.
 * Objects and arrays are frozen; a Map or Set keeps its entries and refuses `set`, `add`, `delete`
 * and `clear`. A typed array or buffer cannot be frozen and is left as it is; nothing a read answers
 * holds one.
 */

const refuse = (what: string) => () => {
  throw new TypeError(`${what} is a read answer shared across a request and cannot change`);
};

export function frozen<T>(value: T): T {
  freeze(value, new WeakSet());
  return value;
}

function freeze(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
  if (value instanceof Map) {
    for (const [k, v] of value) {
      freeze(k, seen);
      freeze(v, seen);
    }
    for (const m of ['set', 'delete', 'clear'])
      Object.defineProperty(value, m, { value: refuse(`Map.${m}`) });
  } else if (value instanceof Set) {
    for (const v of value) freeze(v, seen);
    for (const m of ['add', 'delete', 'clear'])
      Object.defineProperty(value, m, { value: refuse(`Set.${m}`) });
  } else {
    for (const v of Object.values(value)) freeze(v, seen);
  }
  Object.freeze(value);
}

/** The one comparator that orders keys: UTF-16 code units, as `Array.prototype.sort` does by default. */
export function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The value with every object's keys sorted and `undefined` fields dropped, the way `jsonb` would hold it. */
export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => byCodeUnits(a, b));
  return Object.fromEntries(entries.map(([k, v]) => [k, stableValue(v)]));
}

/** Compact JSON of the value in key order: equal for two values that differ only in key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/** The generated contract artifacts: key-sorted, two-space indent, trailing newline. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

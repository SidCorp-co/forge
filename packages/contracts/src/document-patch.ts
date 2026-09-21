/**
 * The write contract for a stored settings document: a caller sends the values it read
 * (`base`) beside the keys it wants changed (`patch`), and the store applies the write whole
 * or refuses it whole.
 *
 * A patch is sparse. A key it does not name is untouched at any depth; an object merges into
 * an object; an array or a scalar replaces; `null` deletes the key. Comparison happens at the
 * paths the patch writes and nowhere else, so two writers that name no common path both land
 * from one read, and two that name the same path cannot both be applied.
 */

export type DocumentPatch = Record<string, unknown>;

export interface PatchConflict {
  /** Dotted path, from the document root. */
  path: string;
  /** What the caller read there. */
  base: unknown;
  /** What is there now. */
  stored: unknown;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keys sorted at every depth, so two structurally equal values render the same string. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const body = Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Equality as the store sees it. A key that is absent and a key holding `null` are the same
 * value in these documents: `null` is what a patch sends to delete, and every reader of
 * `pipelineConfig` and of `environments` answers the same for both. Comparing them as
 * different would refuse a caller for a distinction nothing downstream can observe.
 */
export function sameStoredValue(a: unknown, b: unknown): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return deepEqual(a, b);
}

export function applyDocumentPatch(
  current: unknown,
  patch: DocumentPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
      continue;
    }
    if (isPlainObject(value)) {
      next[key] = applyDocumentPatch(next[key], value);
      continue;
    }
    next[key] = value;
  }
  return next;
}

/**
 * The dotted paths a patch writes. A nested object is walked rather than claimed, so a patch
 * naming `states.open.deviceIds` conflicts with nothing else under `states`. An empty object
 * writes nothing and claims nothing.
 */
export function patchLeafPaths(patch: DocumentPatch, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      out.push(...patchLeafPaths(value, path));
      continue;
    }
    if (isPlainObject(value)) continue;
    out.push(path);
  }
  return out;
}

export function readPath(document: unknown, path: string): unknown {
  let cursor: unknown = document;
  for (const segment of path.split('.')) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * Where the store disagrees with what the caller read, at the paths this patch writes.
 * An empty list is the write's licence to proceed.
 */
export function comparePatchBase(
  stored: unknown,
  base: unknown,
  patch: DocumentPatch,
): PatchConflict[] {
  const conflicts: PatchConflict[] = [];
  for (const path of patchLeafPaths(patch)) {
    const expected = readPath(base, path);
    const actual = readPath(stored, path);
    if (!sameStoredValue(expected, actual)) {
      conflicts.push({ path, base: expected, stored: actual });
    }
  }
  return conflicts;
}

/**
 * The patch that takes `before` to `after`, beside the base it must be compared against.
 * A caller holding both states of its own slice builds its write from them rather than
 * assembling a whole document by hand.
 */
export function buildDocumentPatch(
  before: unknown,
  after: unknown,
): { patch: DocumentPatch; base: Record<string, unknown> } {
  const from = isPlainObject(before) ? before : {};
  const to = isPlainObject(after) ? after : {};
  return { patch: diff(from, to), base: from };
}

function diff(before: Record<string, unknown>, after: Record<string, unknown>): DocumentPatch {
  const patch: DocumentPatch = {};
  for (const key of Object.keys(before)) {
    const gone = !(key in after) || after[key] === undefined;
    if (gone && !sameStoredValue(before[key], undefined)) patch[key] = null;
  }
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue;
    const previous = before[key];
    if (sameStoredValue(previous, value)) continue;
    if (isPlainObject(previous) && isPlainObject(value)) {
      const nested = diff(previous, value);
      if (Object.keys(nested).length > 0) patch[key] = nested;
      continue;
    }
    patch[key] = value === null ? null : value;
  }
  return patch;
}

/** One line per conflict, for a refusal that has to say what moved. */
export function describeConflicts(conflicts: PatchConflict[]): string {
  return conflicts
    .map((c) => `${c.path}: you read ${canonicalJson(c.base)}, it now holds ${canonicalJson(c.stored)}`)
    .join('; ');
}

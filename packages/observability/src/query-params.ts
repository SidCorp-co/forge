export const REDACTED = '[Redacted]';

const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_DEPTH = 32;
const MAX_CHAIN = 8;
/** Searched for bare from this length; a shorter value would rewrite ordinary words. */
const BARE_VALUE_MIN = 6;
const PRIVATE_USE = String.fromCharCode(0xe000);
const KEPT_USE = String.fromCharCode(0xe001);

/**
 * A marker the text does not contain, holding a redaction's place while the pattern runs so the
 * pattern does not take it again. Built per text: one fixed character could be a bound value's own.
 */
function markerAbsentFrom(text: string, unit = PRIVATE_USE): string {
  let marker = unit;
  while (text.includes(marker)) marker += unit;
  return marker;
}

/** Errors `sealQueryError` has sealed: their own text holds no bound value and is kept as it is. */
const sealedErrors = new WeakSet<object>();
/** A sealed link's bound values, kept for the sinks where the driver's own array was emptied. */
const sealedValues = new WeakMap<object, string[]>();

/** Drizzle's `Failed query: <sql>\nparams: <values>`, the values running to the end of the text. */
function failedQueryParams(held: string): RegExp {
  return new RegExp(`(Failed query: [\\s\\S]*?\\nparams: )(?!${held})[\\s\\S]*$`);
}

/**
 * The database's own texts that quote an input value: a unique, foreign-key or exclusion `detail`,
 * a not-null `detail`, and the messages refusing a value's syntax or range. Each keeps its anchor
 * and loses everything after it, read with no error to say which part is the value.
 */
const QUOTED_VALUE_ANCHORS = [
  'Key \\([^)\\n]*\\)=\\(',
  'Failing row contains \\(',
  'invalid input (?:syntax|value) for (?:type|enum) [^:\\n]*: (?=")',
  'malformed [a-z]+ literal: (?=")',
  'date/time field value out of range: (?=")',
  'value (?="[\\s\\S]*" is out of range for type )',
  'Token (?="[\\s\\S]*" is invalid)',
  'in tsquery: (?=")',
  'invalid value (?=")',
  'JSON data, line \\d+: ',
  'parameter \\$\\d+ = ',
];
const QUOTED_VALUE = new RegExp(`(${QUOTED_VALUE_ANCHORS.join('|')})[\\s\\S]*$`);
/** Every anchor holds one of these, so text holding none skips the pattern. */
const QUOTED_VALUE_HINTS = [
  'Key (',
  'Failing row contains (',
  ': "',
  '" is ',
  'JSON data, line ',
  'parameter $',
  'invalid value "',
];
/** The hints as a JSON line spells them, where a quote is escaped. */
const LINE_HINTS = [
  'params',
  'Failed query: ',
  ...QUOTED_VALUE_HINTS.flatMap((hint) => [hint, JSON.stringify(hint).slice(1, -1)]),
];

function quotesAValue(text: string): boolean {
  return QUOTED_VALUE_HINTS.some((hint) => text.includes(hint)) && QUOTED_VALUE.test(text);
}

/** Whether a finished JSON log line may hold a value worth parsing it for. */
export function mayCarryBoundValues(line: string): boolean {
  return LINE_HINTS.some((hint) => line.includes(hint));
}

interface ChainReading {
  renderings: string[];
  values: string[];
  driverMessages: string[];
  /** A sealed link's message, which no pattern may read as an unredacted failed query. */
  sealed: string[];
}

function boundValuesOf(link: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(link.params)) return link.params;
  if (Array.isArray(link.parameters)) return link.parameters;
  return null;
}

function readChain(err: unknown): ChainReading {
  const reading: ChainReading = { renderings: [], values: [], driverMessages: [], sealed: [] };
  const seen = new Set<unknown>();
  const drivers: string[] = [];
  for (let cur = err, i = 0; cur && typeof cur === 'object' && i < MAX_CHAIN; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const link = cur as Record<string, unknown>;
    const own = link.message;
    if (sealedErrors.has(link) && typeof own === 'string' && own !== '' && own !== REDACTED) {
      reading.sealed.push(own);
    }
    reading.values.push(...(sealedValues.get(link) ?? []));
    const bound = boundValuesOf(link);
    if (bound) {
      reading.renderings.push(`${bound}`);
      for (const v of bound)
        if (v !== null && v !== undefined && `${v}` !== '') reading.values.push(`${v}`);
    }
    if (
      !sealedErrors.has(link) &&
      typeof link.code === 'string' &&
      SQLSTATE.test(link.code) &&
      typeof link.message === 'string'
    ) {
      drivers.push(link.message);
    }
    cur = link.cause;
  }
  reading.driverMessages = drivers.filter((m) => reading.values.some((v) => m.includes(v)));
  return reading;
}

type Span = [start: number, end: number];

function occurrences(text: string, needle: string, from: number, to: number): Span[] {
  const spans: Span[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    spans.push([at + from, at + needle.length - to]);
  }
  return spans;
}

/**
 * Every span of the ORIGINAL text that carries a bound value, overlapping spans merged, so one
 * redaction cannot rewrite the text another one still has to find.
 */
function boundSpans(text: string, chain: ChainReading): Span[] {
  const spans: Span[] = [];
  for (const r of chain.renderings) spans.push(...occurrences(text, `params: ${r}`, 8, 0));
  for (const m of chain.driverMessages) spans.push(...occurrences(text, m, 0, 0));
  for (const v of chain.values) {
    if (v.length >= BARE_VALUE_MIN) spans.push(...occurrences(text, v, 0, 0));
  }
  // A value that is part of the marker shows nothing where the marker stands.
  const markers = occurrences(text, REDACTED, 0, 0);
  const inMarker = ([from, to]: Span) => markers.some(([f, t]) => f <= from && to <= t);
  return mergeSpans(spans.filter((span) => !inMarker(span)));
}

function mergeSpans(spans: Span[]): Span[] {
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

type Mark = [from: number, to: number, kept: number];

/** Where each sealed message stands in `text`, longest first, clear of every span already taken. */
function sealedSpans(text: string, kept: string[], taken: Span[]): Mark[] {
  const found: Mark[] = [];
  const clear = (from: number, to: number) =>
    ![...taken, ...found].some(([f, t]) => from < t && f < to);
  kept.forEach((m, i) => {
    for (const [from, to] of occurrences(text, m, 0, 0)) {
      if (clear(from, to)) found.push([from, to, i]);
    }
  });
  return found;
}

/**
 * `text` redacted against `chain`: its bound values found first, in the original text, then each
 * sealed message clear of them held whole, so no pattern reads a sealed message as a raw one.
 */
function redactText(text: string, chain: ChainReading | null): string {
  if (!chain && !text.includes('Failed query: ') && !quotesAValue(text)) return text;
  const bound = chain ? boundSpans(text, chain) : [];
  const kept = [...new Set(chain?.sealed ?? [])].sort((a, b) => b.length - a.length);
  const sealed = sealedSpans(
    text,
    kept,
    bound.filter(([from, to]) => to > from),
  );
  const marks: Mark[] = [...bound.map(([from, to]): Mark => [from, to, -1]), ...sealed].sort(
    (a, b) => a[0] - b[0] || b[1] - a[1],
  );
  const held = markerAbsentFrom(text);
  const keep = markerAbsentFrom(text, KEPT_USE);
  let out = '';
  let at = 0;
  for (const [from, to, i] of marks) {
    if (from < at) continue;
    out += `${text.slice(at, from)}${i < 0 ? held : `${keep}${i}${keep}`}`;
    at = to;
  }
  out += text.slice(at);
  out = out.replace(failedQueryParams(held), `$1${held}`);
  if (quotesAValue(out)) out = out.replace(QUOTED_VALUE, `$1${held}`);
  const token = new RegExp(`${keep}(\\d+)${keep}`, 'g');
  return out.split(held).join(REDACTED).replace(token, (_, i) => kept[Number(i)] ?? '');
}

function mergeChains(a: ChainReading | null, b: ChainReading): ChainReading {
  if (!a) return b;
  return {
    renderings: [...a.renderings, ...b.renderings],
    values: [...a.values, ...b.values],
    driverMessages: [...a.driverMessages, ...b.driverMessages],
    sealed: [...a.sealed, ...b.sealed],
  };
}

/**
 * Of a driver error, the fields that name where it failed. Every other field (`detail`, `where`,
 * `hint`, `internal_query`, and whatever a driver adds) may be filled from the input, so it goes
 * whole; the message, stack, statement and cause are walked as any value is.
 */
const DRIVER_FIELDS_KEPT = new Set([
  'code',
  'severity',
  'severity_local',
  'name',
  'position',
  'internal_position',
  'internalPosition',
  'schema_name',
  'schema',
  'table_name',
  'table',
  'column_name',
  'column',
  'data_type_name',
  'dataType',
  'constraint_name',
  'constraint',
  'sqlstate',
  'file',
  'line',
  'routine',
]);
const DRIVER_WALKED = new Set(['message', 'stack', 'query', 'type', 'cause', 'aggregateErrors']);

function isDriverError(value: Record<string, unknown>): boolean {
  const { code, severity } = value;
  return typeof code === 'string' && SQLSTATE.test(code) && typeof severity === 'string';
}

function driverFieldWithheld(key: string, v: unknown): boolean {
  return !DRIVER_FIELDS_KEPT.has(key) && !DRIVER_WALKED.has(key) && v !== null && v !== undefined;
}

/** A read of the caller's code that threw, written `[Redacted]` where it stood. */
const UNREADABLE = Symbol('unreadable');
const CIRCULAR = '[Circular]';

function attempt<T>(read: () => T): T | typeof UNREADABLE {
  try {
    return read();
  } catch {
    return UNREADABLE;
  }
}

/** A boxed primitive's value as `JSON.stringify` unboxes it, through its toPrimitive; else none. */
function unboxed(value: object): { value: unknown } | null {
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null || Array.isArray(value)) return null;
  const is = (unbox: () => unknown) => attempt(unbox) !== UNREADABLE;
  let out: unknown = UNREADABLE;
  if (is(() => String.prototype.valueOf.call(value))) out = attempt(() => String(value));
  else if (is(() => Number.prototype.valueOf.call(value))) out = attempt(() => Number(value));
  else if (is(() => Boolean.prototype.valueOf.call(value))) {
    out = Boolean.prototype.valueOf.call(value);
  } else return null;
  return { value: out === UNREADABLE ? REDACTED : out };
}

/** How `asSerialized` renders: the logger reads an error by its serializer, not by its `toJSON`. */
export interface Rendering {
  /** `value` is a set of fields, as a logger's merging object or bindings: no toJSON asked. */
  fields?: boolean;
  /** An `Error` is handed back as it is, for a serializer of errors to read. */
  errorsAsThemselves?: boolean;
  /**
   * Field names the sink censors by path, as pino's `redact` does: a `toJSON` is asked with them
   * already censored, since the text it renders carries no name for the sink to censor it by.
   */
  censor?: ReadonlySet<string>;
}

interface Walk extends Rendering {
  errors: Error[];
  /** The objects the walk is inside, so one that holds itself is told from one met twice. */
  open: Set<object>;
}

/**
 * `value` as a serializer would write it at `key`, every piece of the caller's code that writing
 * calls run here and once: a `toJSON` asked with the key, a boxed primitive unboxed, a getter
 * read. What comes back calls none of it again: anything rendered comes back as plain data, and
 * an object holding no hook is the same reference. A hook that throws is written `[Redacted]`, a
 * value that holds itself `[Circular]`, and every `Error` met on the way is collected.
 */
function render(value: unknown, key: string, depth: number, walk: Walk, top = false): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (depth > MAX_DEPTH) return REDACTED;
  if (value instanceof Error) walk.errors.push(value);
  const asError = value instanceof Error && walk.errorsAsThemselves;
  // A toJSON read through a getter may answer otherwise when the serializer reads it again.
  let copy = false;
  if (!(top && walk.fields) && !asError) {
    copy = toJSONByGetter(value);
    const toJSON = attempt(() => (value as { toJSON?: unknown }).toJSON);
    if (toJSON === UNREADABLE) return REDACTED;
    if (typeof toJSON === 'function') {
      collectHeld(value, walk, depth);
      const self = walk.censor ? censored(value, walk.censor) : value;
      const out = attempt(() => toJSON.call(self, key) as unknown);
      return out === UNREADABLE ? REDACTED : renderResult(out, depth, walk);
    }
  }
  // A function a serializer writes as nothing, unless its toJSON getter may answer otherwise later.
  if (typeof value === 'function') return copy ? undefined : value;
  const box = unboxed(value);
  if (box) return box.value;
  if (walk.open.has(value)) return CIRCULAR;
  if (asError) return value;
  walk.open.add(value);
  const out = renderFields(value, depth, walk, copy);
  walk.open.delete(value);
  return out;
}

/** `value` with each of its own fields named in `names` censored: a copy on its own prototype. */
function censored(value: object, names: ReadonlySet<string>): object {
  const keys = attempt(() => Object.keys(value));
  if (keys === UNREADABLE) return value;
  const hit = keys.filter((k) => names.has(k));
  if (hit.length === 0) return value;
  const copy = attempt(() => {
    const out = Object.create(Object.getPrototypeOf(value)) as object;
    Object.defineProperties(out, Object.getOwnPropertyDescriptors(value));
    for (const k of hit) {
      Object.defineProperty(out, k, { value: REDACTED, enumerable: true, writable: true });
    }
    return out;
  });
  return copy === UNREADABLE ? Object.fromEntries(keys.map((k) => [k, REDACTED])) : copy;
}

/** Whether `value`'s `toJSON`, own or inherited, is a getter rather than a field. */
function toJSONByGetter(value: object): boolean {
  let at: object | null = value;
  while (at) {
    const here: object = at;
    const own = attempt(() => Object.getOwnPropertyDescriptor(here, 'toJSON'));
    if (own === UNREADABLE) return true;
    if (own) return !('value' in own);
    const next = attempt((): object | null => Object.getPrototypeOf(here));
    at = next === UNREADABLE ? null : next;
  }
  return false;
}

/**
 * Every `Error` a value holds in its data fields, collected without running its code: a `toJSON`
 * may hide them from the rendering, and a sibling repeating one's bound values is read against it.
 */
function collectHeld(value: object, walk: Walk, depth: number, seen = new Set<object>()): void {
  if (depth > MAX_DEPTH || seen.has(value)) return;
  seen.add(value);
  const fields = attempt(() => Object.getOwnPropertyDescriptors(value));
  if (fields === UNREADABLE) return;
  for (const own of Object.values(fields)) {
    const v = 'value' in own ? own.value : undefined;
    if (typeof v !== 'object' || v === null) continue;
    if (v instanceof Error) walk.errors.push(v);
    collectHeld(v, walk, depth + 1, seen);
  }
}

/** What a `toJSON` rendered, which a serializer asks nothing more here: no function stays in it. */
function renderResult(rendered: unknown, depth: number, walk: Walk): unknown {
  if (typeof rendered === 'function') return undefined;
  if (rendered === null || typeof rendered !== 'object') return rendered;
  if (rendered instanceof Error) walk.errors.push(rendered);
  const box = unboxed(rendered);
  if (box) return box.value;
  if (walk.open.has(rendered)) return CIRCULAR;
  walk.open.add(rendered);
  const out = renderFields(rendered, depth, walk, true);
  walk.open.delete(rendered);
  return out;
}

/** One field of `value` as JSON reads it: a data value as it stands, a getter called once. */
function readField(value: object, key: string): { value: unknown; called: boolean } {
  const own = attempt(() => Object.getOwnPropertyDescriptor(value, key));
  if (own !== UNREADABLE && (own === undefined || 'value' in own)) {
    return { value: own?.value, called: false };
  }
  const read = attempt(() => (value as Record<string, unknown>)[key]);
  return { value: read === UNREADABLE ? REDACTED : read, called: true };
}

/** `value`'s own enumerable fields rendered, as JSON reads them: a copy where any changed. */
function renderFields(value: object, depth: number, walk: Walk, copy: boolean): unknown {
  const array = Array.isArray(value);
  const length = array ? attempt(() => value.length) : 0;
  const keys = array
    ? Array.from({ length: length === UNREADABLE ? 0 : length }, (_, i) => String(i))
    : attempt(() => Object.keys(value));
  if (keys === UNREADABLE || length === UNREADABLE) return REDACTED;
  let changed = copy;
  const next: Record<string, unknown> = {};
  const items: unknown[] = [];
  for (const key of keys) {
    const field = readField(value, key);
    if (field.called) changed = true;
    const out = render(field.value, key, depth + 1, walk);
    if (out !== field.value) changed = true;
    if (array) items.push(out);
    else if (typeof out !== 'function') next[key] = out;
  }
  if (!changed) return value;
  return array ? items : next;
}

/**
 * `value` as a serializer would write it, with every `Error` met on the way: the one read of the
 * caller's code a redaction makes, so what is redacted is what is written, and what is handed on
 * calls nothing again.
 */
export function asSerialized(
  value: unknown,
  how: Rendering = {},
): { value: unknown; errors: Error[] } {
  const walk: Walk = { ...how, errors: [], open: new Set() };
  return { value: render(value, '', 0, walk, true), errors: walk.errors };
}

/**
 * `value`'s own fields redacted. Read from data a render already made, so no getter runs: a copy
 * where anything changed, otherwise null.
 */
function redactRecord(
  value: Record<string, unknown>,
  chain: ChainReading | null,
  depth: number,
): Record<string, unknown> | null {
  const failedQuery = typeof value.query === 'string';
  const driverError = isDriverError(value);
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    let out: unknown;
    if (failedQuery && (key === 'params' || key === 'parameters') && Array.isArray(v))
      out = REDACTED;
    else if (driverError && driverFieldWithheld(key, v)) out = REDACTED;
    else out = redactValue(v, chain, depth + 1);
    if (out !== v) changed = true;
    next[key] = out;
  }
  return changed ? next : null;
}

/** A rendered `value` redacted, which holds no hook and no value that holds itself. */
function redactValue(value: unknown, chain: ChainReading | null, depth: number): unknown {
  if (typeof value === 'string') return redactText(value, chain);
  if (value === null || typeof value !== 'object') return value;
  // Past the bound nothing was read, so nothing is vouched for: the subtree goes, not through.
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    const next = value.map((v) => redactValue(v, chain, depth + 1));
    return next.some((v, i) => v !== value[i]) ? next : value;
  }
  // An Error left in a payload serializes as its enumerable properties, which for a failed query
  // are `query`, `params` and `cause`: it is walked as that, against its own chain as well.
  const own = value instanceof Error ? mergeChains(chain, readChain(value)) : chain;
  return redactRecord(value as Record<string, unknown>, own, depth) ?? value;
}

/** Every `Error` inside `value`, so a sibling repeating one of its bound values is read against it. */
export function errorsWithin(value: unknown): unknown[] {
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): void => {
    if (typeof v !== 'object' || v === null || seen.has(v) || depth > MAX_DEPTH) return;
    seen.add(v);
    if (v instanceof Error) found.push(v);
    for (const child of Object.values(v)) walk(child, depth + 1);
  };
  walk(value, 0);
  return found;
}

/**
 * `value` with every bound parameter of a failed SQL statement replaced by `[Redacted]`, the same
 * reference where there was none. It is redacted as a serializer would write it (`asSerialized`):
 * what comes back holds plain data wherever the caller's code rendered any. `err`, the error
 * `value` was made from (or every error, as an array), and every `Error` inside `value` let the
 * statement and the driver's reason survive and name the values to find anywhere in it; without
 * any, a failed query's text is redacted to its end. The database's own texts that quote a value
 * lose it whether or not an error names it. An `Error` inside `value` that carries one comes back
 * as the plain object it serializes as.
 */
export function redactQueryParams<T>(value: T, err?: unknown): T {
  const written = asSerialized(value);
  const errs: unknown[] = err === undefined ? [] : Array.isArray(err) ? [...err] : [err];
  errs.push(...written.errors);
  const chain = errs.reduce<ChainReading | null>((acc, e) => mergeChains(acc, readChain(e)), null);
  return redactValue(written.value, chain, 0) as T;
}

/**
 * An error's message as text to log or store, redacted while the error that names its bound values
 * is still in hand: once it is a bare string, a value only the error could name cannot be found.
 */
export function redactedMessage(err: unknown): string {
  return redactQueryParams(err instanceof Error ? err.message : String(err), err);
}

/** A field the driver defined for good: postgres-js's `parameters` and `args` under `debug`. */
function fixedForGood(target: object, key: string): boolean {
  const own = Object.getOwnPropertyDescriptor(target, key);
  return own !== undefined && !own.configurable && !own.writable;
}

type Key = string | symbol;

/** Sets a field where its descriptor allows it; false where only a copy can drop the old value. */
function rewrite(target: object, key: Key, value: unknown, enumerable?: boolean): boolean {
  const own = Object.getOwnPropertyDescriptor(target, key);
  const wanted = enumerable ?? own?.enumerable ?? false;
  try {
    if (!own || own.configurable) {
      const opts = { value, writable: true, configurable: true, enumerable: wanted };
      Object.defineProperty(target, key, opts);
      return true;
    }
    if (!('value' in own) || !own.writable || own.enumerable !== wanted) return false;
    (target as Record<Key, unknown>)[key] = value;
    return (target as Record<Key, unknown>)[key] === value;
  } catch {
    return false;
  }
}

/**
 * A driver's message with every value it quotes removed: an anchor's, a bound value quoted whole,
 * a long one anywhere. One that still holds a bound value at any length goes whole.
 */
function sealedDriverMessage(text: string, values: string[]): string {
  const spans: Span[] = [];
  for (const v of values) {
    spans.push(...occurrences(text, `"${v}"`, 0, 0), ...occurrences(text, `'${v}'`, 0, 0));
    if (v.length >= BARE_VALUE_MIN) spans.push(...occurrences(text, v, 0, 0));
  }
  const held = markerAbsentFrom(text);
  let out = '';
  let at = 0;
  for (const [from, to] of mergeSpans(spans)) {
    out += `${text.slice(at, from)}${held}`;
    at = to;
  }
  out += text.slice(at);
  if (quotesAValue(out)) out = out.replace(QUOTED_VALUE, `$1${held}`);
  const left = out.split(held).join('');
  return values.some((v) => left.includes(v)) ? REDACTED : out.split(held).join(REDACTED);
}

type Change = { value: unknown; enumerable?: boolean };

/** Empties a fixed array of bound values in place; false where a frozen one refuses. */
function emptied(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  try {
    v.splice(0, v.length);
  } catch {
    return false;
  }
  return v.length === 0;
}

function markSealed(link: Error, chain: ChainReading): Error {
  sealedErrors.add(link);
  sealedValues.set(link, chain.values);
  return link;
}

/** `link` rebuilt on its own prototype, `changes` laid over its fields, each one read as data. */
function copyOf(link: Error, changes: Map<string, Change>): Error {
  const copy = Object.create(Object.getPrototypeOf(link)) as Error;
  for (const key of Reflect.ownKeys(link)) {
    const own = Object.getOwnPropertyDescriptor(link, key);
    const value = (link as unknown as Record<Key, unknown>)[key];
    rewrite(copy, key, value, own?.enumerable ?? false);
  }
  for (const [key, { value, enumerable }] of changes) rewrite(copy, key, value, enumerable);
  return copy;
}

/** What sealing `link` changes: its message and stack, and the fields that may hold its input. */
type Fields = Error & Record<string, unknown>;

function sealChanges(link: Fields, chain: ChainReading): Map<string, Change> {
  const changes = new Map<string, Change>();
  let message: string | null = null;
  if (typeof link.query === 'string' && Array.isArray(link.params)) {
    message = redactText(link.message, chain);
    changes.set('params', { value: link.params, enumerable: false });
  } else if (isDriverError(link)) {
    message = sealedDriverMessage(link.message, chain.values);
    for (const [key, v] of Object.entries(link)) {
      if (!driverFieldWithheld(key, v)) continue;
      if (!(fixedForGood(link, key) && emptied(v))) changes.set(key, { value: REDACTED });
    }
  }
  if (message !== null) {
    changes.set('message', { value: message });
    const stack = link.stack;
    if (typeof stack === 'string') {
      changes.set('stack', { value: stack.split(link.message).join(message) });
    }
  }
  return changes;
}

/** `link` sealed in place, or a sealed copy where a field it fixed for good keeps the old value. */
function sealLink(link: Error, chain: ChainReading, cause: Error | null): Error {
  const fields = link as Fields;
  const query =
    !sealedErrors.has(link) &&
    ((typeof fields.query === 'string' && Array.isArray(fields.params)) || isDriverError(fields));
  const changes = query ? sealChanges(fields, chain) : new Map<string, Change>();
  if (cause) changes.set('cause', { value: cause });
  if (changes.size === 0) return link;
  let sealed = link;
  for (const [key, { value, enumerable }] of changes) {
    if (!rewrite(link, key, value, enumerable)) {
      sealed = copyOf(link, changes);
      break;
    }
  }
  return query || sealedErrors.has(link) ? markSealed(sealed, chain) : sealed;
}

function sealFrom(link: Error, chain: ChainReading, seen: Set<unknown>, depth: number): Error {
  if (seen.has(link) || depth >= MAX_CHAIN) return link;
  seen.add(link);
  const cause = (link as { cause?: unknown }).cause;
  const sealedCause = cause instanceof Error ? sealFrom(cause, chain, seen, depth + 1) : cause;
  return sealLink(link, chain, sealedCause !== cause ? (sealedCause as Error) : null);
}

/**
 * `err` with no bound value of a failed statement left in its message, its stack or any
 * enumerable field of it or of a driver error on its chain, sealed in place (a link holding a
 * field it fixed for good is swapped for a sealed copy, and so is every link above it that cannot
 * take the copy as its cause) and handed back, so a caller that copies it copies nothing. The
 * values stay where `redactQueryParams` reads them, to find what a caller repeats beside it.
 * Anything that is not an error is handed back untouched.
 */
export function sealQueryError<T>(err: T): T {
  if (!(err instanceof Error)) return err;
  return sealFrom(err, readChain(err), new Set(), 0) as T;
}

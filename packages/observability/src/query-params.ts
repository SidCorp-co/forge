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
    if (sealedErrors.has(link) && typeof link.message === 'string' && link.message !== REDACTED) {
      reading.sealed.push(link.message);
    }
    const bound = boundValuesOf(link);
    if (bound) {
      reading.renderings.push(`${bound}`);
      for (const v of bound)
        if (v !== null && v !== undefined && `${v}` !== '') reading.values.push(`${v}`);
    }
    if (
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
  return mergeSpans(spans);
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

/** `text` with each sealed message swapped for a token, and the swap back. */
function keepSealed(text: string, sealed: string[]): [string, (t: string) => string] {
  if (sealed.length === 0) return [text, (t) => t];
  const keep = markerAbsentFrom(text, KEPT_USE);
  const kept = [...new Set(sealed)].sort((a, b) => b.length - a.length);
  let out = text;
  kept.forEach((m, i) => {
    out = out.split(m).join(`${keep}${i}${keep}`);
  });
  const token = new RegExp(`${keep}(\\d+)${keep}`, 'g');
  return [out, (t) => t.replace(token, (_, i) => kept[Number(i)] ?? '')];
}

function redactText(original: string, chain: ChainReading | null): string {
  if (!chain && !original.includes('Failed query: ') && !quotesAValue(original)) return original;
  const [text, restore] = keepSealed(original, chain?.sealed ?? []);
  const held = markerAbsentFrom(text);
  let out = text;
  if (chain) {
    const spans = boundSpans(text, chain);
    out = '';
    let at = 0;
    for (const [from, to] of spans) {
      out += `${text.slice(at, from)}${held}`;
      at = to;
    }
    out += text.slice(at);
  }
  out = out.replace(failedQueryParams(held), `$1${held}`);
  if (quotesAValue(out)) out = out.replace(QUOTED_VALUE, `$1${held}`);
  return restore(out.split(held).join(REDACTED));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === '[object Object]';
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

function redactValue(value: unknown, chain: ChainReading | null, depth: number): unknown {
  if (typeof value === 'string') return redactText(value, chain);
  // Past the bound nothing was read, so nothing is vouched for: the subtree goes, not through.
  if (depth > MAX_DEPTH) return typeof value === 'object' && value !== null ? REDACTED : value;
  if (Array.isArray(value)) {
    const next = value.map((v) => redactValue(v, chain, depth + 1));
    return next.some((v, i) => v !== value[i]) ? next : value;
  }
  // An Error left in a payload serializes as its enumerable properties, which for a failed query
  // are `query`, `params` and `cause`: it is walked as that, against its own chain as well.
  if (value instanceof Error) {
    const own = value as unknown as Record<string, unknown>;
    return redactRecord(own, mergeChains(chain, readChain(value)), depth) ?? value;
  }
  if (!isRecord(value)) return value;
  return redactRecord(value, chain, depth) ?? value;
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
 * reference where there was none. `err`, the error `value` was made from (or every error, as an
 * array), and every `Error` inside `value` let the statement and the driver's reason survive and
 * name the values to find anywhere in it; without any, a failed query's text is redacted to its
 * end. The database's own texts that quote a value lose it whether or not an error names it. An
 * `Error` inside `value` that carries one comes back as the plain object it serializes as.
 */
export function redactQueryParams<T>(value: T, err?: unknown): T {
  const errs: unknown[] = err === undefined ? [] : Array.isArray(err) ? [...err] : [err];
  errs.push(...errorsWithin(value));
  const chain = errs.reduce<ChainReading | null>((acc, e) => mergeChains(acc, readChain(e)), null);
  return redactValue(value, chain, 0) as T;
}

/**
 * An error's message as text to log or store, redacted while the error that names its bound values
 * is still in hand: once it is a bare string, a value only the error could name cannot be found.
 */
export function redactedMessage(err: unknown): string {
  return redactQueryParams(err instanceof Error ? err.message : String(err), err);
}

/** Leaves a field the driver fixed for good (postgres-js under `debug`) to the sinks' redaction. */
function rewrite(target: object, key: string, value: unknown, enumerable?: boolean): void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  if (own && !own.configurable && !own.writable) return;
  Object.defineProperty(target, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: enumerable ?? own?.enumerable ?? false,
  });
}

/** An error's message and its stack, which opens with the message, so it is swapped there too. */
function rewriteMessage(link: Error, message: string): void {
  const before = link.message;
  const stack = link.stack;
  rewrite(link, 'message', message);
  if (typeof stack === 'string') rewrite(link, 'stack', stack.split(before).join(message));
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

function sealLink(link: Error & Record<string, unknown>, chain: ChainReading): void {
  if (typeof link.query === 'string' && Array.isArray(link.params)) {
    rewriteMessage(link, redactText(link.message, chain));
    rewrite(link, 'params', link.params, false);
  } else if (isDriverError(link)) {
    for (const [key, v] of Object.entries(link)) {
      if (driverFieldWithheld(key, v)) rewrite(link, key, REDACTED);
    }
    rewriteMessage(link, sealedDriverMessage(link.message, chain.values));
  } else return;
  sealedErrors.add(link);
}

/**
 * `err` with no bound value of a failed statement left in its message, its stack or any
 * enumerable field of it or of a driver error on its chain, mutated in place and handed back so a
 * caller that copies it later copies nothing. The values stay readable on the non-enumerable
 * `params` and `parameters`, where `redactQueryParams` finds what a caller repeats beside it.
 * Anything that is not an error is handed back untouched.
 */
export function sealQueryError<T>(err: T): T {
  if (!(err instanceof Error)) return err;
  const chain = readChain(err);
  const seen = new Set<unknown>();
  for (let cur: unknown = err, i = 0; cur instanceof Error && i < MAX_CHAIN; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const link = cur as Error & Record<string, unknown>;
    if (!sealedErrors.has(link)) sealLink(link, chain);
    cur = link.cause;
  }
  return err;
}

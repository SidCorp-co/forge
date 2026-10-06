export const REDACTED = '[Redacted]';

const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_DEPTH = 16;
const MAX_CHAIN = 8;
/** Searched for bare from this length; a shorter value would rewrite ordinary words. */
const BARE_VALUE_MIN = 6;
const PRIVATE_USE = String.fromCharCode(0xe000);

/**
 * A marker the text does not contain, holding a redaction's place while the pattern runs so the
 * pattern does not take it again. Built per text: one fixed character could be a bound value's own.
 */
function markerAbsentFrom(text: string): string {
  let marker = PRIVATE_USE;
  while (text.includes(marker)) marker += PRIVATE_USE;
  return marker;
}

/** Drizzle's `Failed query: <sql>\nparams: <values>`, the values running to the end of the text. */
function failedQueryParams(held: string): RegExp {
  return new RegExp(`(Failed query: [\\s\\S]*?\\nparams: )(?!${held})[\\s\\S]*$`);
}

interface ChainReading {
  renderings: string[];
  values: string[];
  driverMessages: string[];
}

function boundValuesOf(link: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(link.params)) return link.params;
  if (Array.isArray(link.parameters)) return link.parameters;
  return null;
}

function readChain(err: unknown): ChainReading {
  const reading: ChainReading = { renderings: [], values: [], driverMessages: [] };
  const seen = new Set<unknown>();
  const drivers: string[] = [];
  for (let cur = err, i = 0; cur && typeof cur === 'object' && i < MAX_CHAIN; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const link = cur as Record<string, unknown>;
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

function redactText(text: string, chain: ChainReading | null): string {
  if (!chain && !text.includes('Failed query: ')) return text;
  const held = markerAbsentFrom(text);
  let out = text;
  if (chain) {
    for (const r of chain.renderings) out = out.split(`params: ${r}`).join(`params: ${held}`);
    for (const m of chain.driverMessages) out = out.split(m).join(held);
  }
  out = out.replace(failedQueryParams(held), `$1${REDACTED}`);
  if (chain) {
    for (const v of chain.values) if (v.length >= BARE_VALUE_MIN) out = out.split(v).join(REDACTED);
  }
  return out.split(held).join(REDACTED);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === '[object Object]';
}

function redactValue(value: unknown, chain: ChainReading | null, depth: number): unknown {
  if (typeof value === 'string') return redactText(value, chain);
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    const next = value.map((v) => redactValue(v, chain, depth + 1));
    return next.some((v, i) => v !== value[i]) ? next : value;
  }
  if (!isRecord(value)) return value;
  const failedQuery = typeof value.query === 'string';
  const driverError =
    typeof value.code === 'string' &&
    SQLSTATE.test(value.code) &&
    typeof value.severity === 'string';
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    let out: unknown;
    if (failedQuery && (key === 'params' || key === 'parameters') && Array.isArray(v))
      out = REDACTED;
    else if (driverError && key === 'detail' && typeof v === 'string') out = REDACTED;
    else out = redactValue(v, chain, depth + 1);
    if (out !== v) changed = true;
    next[key] = out;
  }
  return changed ? next : value;
}

/**
 * `value` with every bound parameter of a failed SQL statement replaced by `[Redacted]`, the same
 * reference where there was none. `err`, the error `value` was made from, lets the statement and
 * the driver's reason survive; without it a failed query's text is redacted to its end. An `Error`
 * is not walked: serialize it first.
 */
export function redactQueryParams<T>(value: T, err?: unknown): T {
  const chain = err === undefined ? null : readChain(err);
  return redactValue(value, chain, 0) as T;
}

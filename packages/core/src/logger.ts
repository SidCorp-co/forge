import {
  asSerialized,
  errorsWithin,
  type FieldReads,
  holding,
  isError,
  mayCarryBoundValues,
  REDACTED,
  readOnce,
  redactQueryParams,
} from '@forge/observability';
import type { Context } from 'hono';
import {
  type Bindings,
  type ChildLoggerOptions,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
  pino,
  stdSerializers,
} from 'pino';
import { pgConstraintName, pgErrorCode } from './lib/db-errors.js';

const isProd = process.env.NODE_ENV === 'production';
// pino-pretty is dev-only — use JSON in staging/test for parity with prod and so
// the runtime image (omit=dev) doesn't crash trying to load pino-pretty.
const usePrettyTransport = process.env.NODE_ENV === 'development';
const defaultLevel = isProd ? 'info' : 'debug';

const redactPaths = [
  'password',
  'token',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

const censoredPaths = redactPaths.map((path) => path.split('.'));

/** What the censor pass read and could not censor, handed to the rendering that follows it. */
interface Censored {
  reads: FieldReads;
  withheld: Set<object>;
}

/**
 * `render` run with every redact path in `root` censored in place by descriptor (no setter runs)
 * and put back after, as pino censors before it serializes: data-reached fields first, then past
 * each getter, held as the object it answered. What cannot be censored is `withheld`.
 */
function withPathsCensored<T>(root: unknown, render: (censored: Censored) => T): T {
  const held = holding();
  const censored: Censored = { reads: held.reads, withheld: new Set() };
  const { hold } = held;
  const withhold = (on: object[]) => {
    for (const o of on) censored.withheld.add(o);
  };
  // The first pass follows data only; the second also each getter, and censors what lies past one.
  const visit = (at: unknown, path: string[], trail: object[], getters: boolean, past: boolean) => {
    const [head, ...tail] = path;
    // A function JSON writes through its toJSON holds fields a path names as an object does.
    if ((typeof at !== 'object' && typeof at !== 'function') || at === null) return;
    if (head === undefined) return;
    const on = [...trail, at];
    let keys: string[];
    try {
      keys = head === '*' ? Object.keys(at) : [head];
    } catch {
      // Fields that cannot be listed cannot be censored: none of the object's code runs after.
      withhold(on);
      return;
    }
    for (const key of keys) {
      try {
        if (!(key in at)) continue;
        if (tail.length === 0) {
          if (past === getters && !hold(at, key, '[Redacted]')) withhold(on);
          continue;
        }
        // A getter an earlier path held stands as data now, and is still one this path passed.
        const held = censored.reads.get(at)?.has(key) === true;
        const own = Object.getOwnPropertyDescriptor(at, key);
        if (own && 'value' in own) {
          visit(own.value, tail, on, getters, past || held);
          continue;
        }
        if (!getters || censored.withheld.has(at)) continue;
        const read = readOnce(at, key, censored.reads);
        // A throw stands as read: what it threw is a hint the rendering still collects.
        if (read.threw) continue;
        if (typeof read.value !== 'object' || read.value === null) {
          // Nothing lies past it: the rendering reads it once more, after every censor landed.
          censored.reads.get(at)?.delete(key);
          continue;
        }
        if (!hold(at, key, read.value)) withhold(on);
        visit(read.value, tail, on, getters, true);
      } catch {
        withhold(on);
      }
    }
  };
  try {
    for (const getters of [false, true]) {
      for (const path of censoredPaths) visit(root, path, [], getters, false);
    }
    return render(censored);
  } finally {
    held.release();
  }
}

/**
 * A finished line with a failed query's params, and any value the database's own text quotes,
 * redacted: the last pass, blind to the call's errors, over what reached the line by a path the
 * call's own redaction did not see. A value's `toJSON`, getters and boxed text were rendered there.
 */
function redactLine(line: string): string {
  if (!mayCarryBoundValues(line)) return line;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return redactQueryParams(line);
  }
  const redacted = besideErr(parsed, (rest) => redactQueryParams(rest));
  return redacted === parsed ? line : `${JSON.stringify(redacted)}\n`;
}

/**
 * `record` with `redact` applied to everything but `err` as ONE record, so a `query` keeps its
 * `params` beside it. `err` is left as it is: `serializeError` redacted whatever it held, as it
 * will be serialized, and a second, blind pass would take the database's reason that follows the
 * params along with them.
 */
function besideErr(
  record: Record<string, unknown>,
  redact: (rest: Record<string, unknown>) => unknown,
): Record<string, unknown> {
  const { err, ...rest } = record;
  const out = redact(rest);
  if (out === rest) return record;
  return Object.hasOwn(record, 'err')
    ? { ...(out as object), err }
    : (out as Record<string, unknown>);
}

/** The error a call logs: its message text reads it, and pino takes `msg` from it when none is named. */
function loggedError(first: unknown): Error | null {
  if (isError(first)) return first;
  const err = (first as { err?: unknown } | null)?.err;
  return isError(err) ? err : null;
}

/**
 * `value` with every `Error` inside it serialized as `err` is, so an error carried in context or
 * interpolated with `%j` brings its message and SQLSTATE and none of its bound values.
 */
function withErrorsSerialized(value: unknown, depth = 0): unknown {
  if (isError(value)) return serializeError(value);
  if (depth >= 8 || typeof value !== 'object' || value === null) return value;
  if (!Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Object]') {
    return value;
  }
  const entries = Object.entries(value);
  const next = entries.map(([k, v]) => [k, withErrorsSerialized(v, depth + 1)] as const);
  if (next.every(([, v], i) => v === entries[i]?.[1])) return value;
  return Array.isArray(value) ? next.map(([, v]) => v) : Object.fromEntries(next);
}

/**
 * The indexes of the arguments pino's formatter renders with `String()`: each one a `%s` in
 * `template` consumes. Every other `%` pair consumes one too, and `%%` none, as its formatter counts.
 */
function stringifiedArgs(template: string): Set<number> {
  const at = new Set<number>();
  let arg = 0;
  for (let i = 0; i < template.length - 1; i++) {
    if (template[i] !== '%') continue;
    if (template[i + 1] === '%') {
      i++;
      continue;
    }
    if (template[i + 1] === 's') at.add(arg);
    arg++;
  }
  return at;
}

function rendersItself(v: unknown): v is object {
  return (typeof v === 'object' && v !== null) || typeof v === 'function';
}

/**
 * The call's arguments with every error in them serialized, and all of its text redacted against
 * every error it carries, which only this hook still holds: a value the call repeats beside its
 * error, or a driver message repeating a short one, is told only by the values the errors carry.
 * What pino would later render from a value's own code is rendered here, once, before any of it
 * is read: a `%s` argument's `String()`, a message joined to a child's `msgPrefix`, and each
 * argument as it serializes (`asSerialized`), the merging object by its fields as pino reads it.
 */
function redactCall(args: unknown[], msgPrefix: unknown): unknown[] {
  const templateAt = typeof args[0] === 'string' ? 0 : 1;
  const template = args[templateAt];
  const stringified = typeof template === 'string' ? stringifiedArgs(template) : new Set<number>();
  const found: Error[] = [];
  let [first, ...rest] = args.map((v, i) => {
    const joined = i === templateAt && typeof msgPrefix === 'string';
    const stringify = i > templateAt && stringified.has(i - templateAt - 1);
    if ((joined || stringify) && rendersItself(v)) {
      // The error a text is rendered from still names the values to find in that text.
      found.push(...(errorsWithin(v) as Error[]));
      // A text pino coerces is no field it censors; one whose coercion throws is written redacted.
      try {
        if (joined)
          return ((msgPrefix as string) + (v as unknown as string)).slice(
            (msgPrefix as string).length,
          );
        return String(v);
      } catch (error) {
        // What it threw still names the values to find in the rest of the call.
        if (isError(error)) found.push(error);
        return REDACTED;
      }
    }
    // pino censors its redact paths in the merging object and in every argument it writes as JSON.
    const how = { fields: i === 0, errorsAsThemselves: true };
    const written = isError(v)
      ? asSerialized(v, how)
      : withPathsCensored(v, (censored) => asSerialized(v, { ...how, ...censored }));
    found.push(...written.errors);
    return written.value;
  });
  const err = loggedError(first);
  const errors = [...new Set([...found, ...errorsWithin([first, ...rest])])];
  const clean = (v: unknown) =>
    redactQueryParams(withErrorsSerialized(v), errors.length > 0 ? errors : undefined);
  rest = rest.map(clean);
  const named = first as { msg?: unknown };
  if (typeof first === 'string') first = clean(first);
  else if (isError(first)) first = { err: serializeError(first, errors) };
  else if (typeof first === 'object' && first !== null) {
    const record = besideErr(first as Record<string, unknown>, clean);
    first = Object.hasOwn(record, 'err')
      ? { ...record, err: serializeError(record.err, errors) }
      : record;
  }
  if (err && typeof named?.msg !== 'string' && typeof rest[0] !== 'string') {
    rest = [redactQueryParams(err.message, errors), ...rest];
  }
  return [first, ...rest];
}

/** Objects `serializeError` built; never a caller's own, which may change before its next line. */
const serialized = new WeakSet<object>();

/** pino's own, redacted, plus the SQLSTATE and constraint; any non-Error under `err` is redacted too. */
function serializeError(err: unknown, hints: unknown[] = errorsWithin(err)): unknown {
  if (typeof err === 'object' && err !== null && serialized.has(err)) return err;
  let out: unknown;
  if (isError(err)) {
    out = redactQueryParams(stdSerializers.err(err), hints.length > 0 ? hints : [err]);
    const sqlstate = pgErrorCode(err);
    if (sqlstate && typeof out === 'object' && out !== null) {
      out = { ...out, sqlstate, constraint: pgConstraintName(err) };
    }
  } else {
    out = redactQueryParams(withErrorsSerialized(err), hints.length > 0 ? hints : undefined);
  }
  if (typeof out === 'object' && out !== null && out !== err) serialized.add(out);
  return out;
}

/** A child's bindings, or `setBindings`', rendered once, with every error met on the way. */
function writtenBindings(given: Bindings): { bindings: Bindings; errors: Error[] } {
  const how = { fields: true, errorsAsThemselves: true };
  const written = withPathsCensored(given, (censored) =>
    asSerialized(given, { ...how, ...censored }),
  );
  const bindings = written.value as Bindings;
  return {
    bindings,
    errors: [...new Set([...written.errors, ...errorsWithin(bindings)])] as Error[],
  };
}

/** Rendered bindings redacted as a call's own arguments are. */
function redactBindings({ bindings, errors }: { bindings: Bindings; errors: Error[] }): Bindings {
  const record = besideErr(bindings, (rest) =>
    redactQueryParams(withErrorsSerialized(rest), errors.length > 0 ? errors : undefined),
  );
  return Object.hasOwn(record, 'err')
    ? { ...record, err: serializeError(record.err, errors) }
    : record;
}

/**
 * pino serializes a child's bindings once, when the child is made, and never hands them to
 * `hooks.logMethod`; a `msgPrefix` is prepended after it. So both are redacted at `child` and
 * `setBindings`, set on the root and inherited by every descendant, which pino builds from it.
 */
function redactingChildren(root: Logger): Logger {
  type Child = (this: Logger, b: Bindings, o?: ChildLoggerOptions) => Logger;
  const child = root.child as unknown as Child;
  const setBindings = root.setBindings;
  root.child = function (this: Logger, bindings: Bindings, options?: ChildLoggerOptions) {
    const written = writtenBindings(bindings);
    const prefix = options?.msgPrefix;
    const redacted =
      typeof prefix === 'string'
        ? { ...options, msgPrefix: redactQueryParams(prefix, written.errors) }
        : options;
    return child.call(this, redactBindings(written), redacted as ChildLoggerOptions);
  } as unknown as Logger['child'];
  root.setBindings = function (this: Logger, bindings: Bindings) {
    setBindings.call(this, redactBindings(writtenBindings(bindings)));
  };
  return root;
}

const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? defaultLevel,
  redact: { paths: redactPaths, censor: '[Redacted]' },
  serializers: { err: serializeError },
  hooks: {
    logMethod(args, method) {
      const redacted = redactCall(args, this.msgPrefix);
      return method.apply(this, redacted as Parameters<typeof method>);
    },
    streamWrite: redactLine,
  },
};

/** A logger built as core's is: every line, child and binding redacted. */
export function createLogger(options: LoggerOptions = {}, stream?: DestinationStream): Logger {
  const opts = { ...loggerOptions, ...options };
  return redactingChildren(stream ? pino(opts, stream) : pino(opts));
}

export const logger: Logger = createLogger(
  usePrettyTransport
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l' },
        },
      }
    : {},
);

export function getLogger(c: Context): Logger {
  const requestId = c.get('requestId' as never) as string | undefined;
  return requestId ? logger.child({ requestId }) : logger;
}

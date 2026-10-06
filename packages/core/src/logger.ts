import { redactQueryParams } from '@forge/observability';
import type { Context } from 'hono';
import { type Logger, type LoggerOptions, pino, stdSerializers } from 'pino';
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

/**
 * A finished line with a failed query's params redacted. The `err` serializer has already redacted
 * what the error itself carried; this reaches what it cannot see — pino's `msg`, which defaults to
 * the raw `err.message`, an error under another key, a message interpolated into the text.
 */
function redactLine(line: string): string {
  if (!line.includes('params')) return line;
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
 * `params` beside it. `err` is left as it is: `serializeError` read the error itself, and a second,
 * blind pass would take the database's reason that follows the params along with them.
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
  if (first instanceof Error) return first;
  const err = (first as { err?: unknown } | null)?.err;
  return err instanceof Error ? err : null;
}

/**
 * `value` with every `Error` inside it serialized as `err` is, so an error carried in context or
 * interpolated with `%j` brings its message and SQLSTATE and none of its bound values.
 */
function withErrorsSerialized(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return serializeError(value);
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
 * The call's arguments with every error in them serialized and, where the call logs an error, its
 * text redacted against that error, which only this hook still holds: a driver message repeating a
 * short bound value is told only by the values the error carries.
 */
function redactCall(args: unknown[], err: Error | null): unknown[] {
  const clean = (v: unknown) => redactQueryParams(withErrorsSerialized(v), err ?? undefined);
  let [first, ...rest] = args;
  rest = rest.map(clean);
  const named = first as { msg?: unknown };
  if (typeof first === 'object' && first !== null && !(first instanceof Error)) {
    first = besideErr(first as Record<string, unknown>, clean);
  }
  if (err && typeof named?.msg !== 'string' && typeof rest[0] !== 'string') {
    rest = [redactQueryParams(err.message, err), ...rest];
  }
  return [first, ...rest];
}

/** pino's own, redacted, plus the SQLSTATE and constraint a wrapped driver error keeps on `cause`. */
function serializeError(err: unknown): unknown {
  const out = redactQueryParams(stdSerializers.err(err as Error), err);
  const sqlstate = pgErrorCode(err);
  if (!sqlstate || typeof out !== 'object' || out === null) return out;
  return { ...out, sqlstate, constraint: pgConstraintName(err) };
}

export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? defaultLevel,
  redact: { paths: redactPaths, censor: '[Redacted]' },
  serializers: { err: serializeError },
  hooks: {
    logMethod(args, method) {
      const err = loggedError(args[0]);
      return method.apply(this, redactCall(args, err) as Parameters<typeof method>);
    },
    streamWrite: redactLine,
  },
};

export const logger: Logger = pino({
  ...loggerOptions,
  ...(usePrettyTransport
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l' },
        },
      }
    : {}),
});

export function getLogger(c: Context): Logger {
  const requestId = c.get('requestId' as never) as string | undefined;
  return requestId ? logger.child({ requestId }) : logger;
}

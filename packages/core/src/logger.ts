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
  let changed = false;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    // `err` went through `serializeError`, which read the error itself; a second, blind pass would
    // take the database's reason that follows the params along with them.
    redacted[key] = key === 'err' ? value : redactQueryParams(value);
    if (redacted[key] !== value) changed = true;
  }
  return changed ? `${JSON.stringify(redacted)}\n` : line;
}

/** The error a call logs: its message text reads it, and pino takes `msg` from it when none is named. */
function loggedError(first: unknown): Error | null {
  if (first instanceof Error) return first;
  const err = (first as { err?: unknown } | null)?.err;
  return err instanceof Error ? err : null;
}

/**
 * The call's text redacted against the error it logs, which only this hook still holds: a driver
 * message repeating a short bound value is told only by the values the error carries.
 */
function redactCall(args: unknown[], err: Error): unknown[] {
  let [first, ...rest] = args;
  rest = rest.map((a) => redactQueryParams(a, err));
  const named = first as { msg?: unknown };
  if (!(first instanceof Error)) {
    first = Object.fromEntries(
      Object.entries(first as object).map(([k, v]) => [
        k,
        k === 'err' ? v : redactQueryParams(v, err),
      ]),
    );
  }
  if (typeof named.msg !== 'string' && typeof rest[0] !== 'string') {
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
      if (!err) return method.apply(this, args);
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

import { scrubLogRecord, scrubLogText } from '@forge/observability';
import type { Context } from 'hono';
import { type Logger, pino, stdSerializers } from 'pino';
import { withoutQueryParams } from './db-errors.js';

const isProd = process.env.NODE_ENV === 'production';
// pino-pretty is dev-only — use JSON in staging/test for parity with prod and so
// the runtime image (omit=dev) doesn't crash trying to load pino-pretty.
const usePrettyTransport = process.env.NODE_ENV === 'development';
const defaultLevel = isProd ? 'info' : 'debug';

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? defaultLevel,
  // cm:why the record, its message and an error's text pass the scrubber Sentry uses, so a secret
  // is filtered by one list whichever way it leaves the process.
  formatters: { log: (record) => scrubLogRecord(record) },
  hooks: {
    logMethod(args, method) {
      method.apply(
        this,
        args.map((a) => (typeof a === 'string' ? scrubLogText(a) : a)) as typeof args,
      );
    },
  },
  serializers: {
    err: (err: unknown) =>
      scrubLogRecord({ ...withoutQueryParams(stdSerializers.err(err as Error), err) }),
  },
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

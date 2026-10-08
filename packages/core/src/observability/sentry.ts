import { scrubSentryEvent } from '@forge/observability';
import * as Sentry from '@sentry/node';
import { sourceCommit } from './source-commit.js';

let initialized = false;

/** Tags a capture site writes from server-held identifiers, put back after the scrub withholds them; no other key is. */
const serverHeldTags = new WeakMap<object, Record<string, string>>();

/** Records `tags` to be restored on the event `captureException(error)` produces. */
export function holdServerTags(error: object, tags: Record<string, string>): void {
  serverHeldTags.set(error, tags);
}

function scrubAndRestoreHeldTags<
  E extends Parameters<typeof scrubSentryEvent>[0] & { tags?: object },
>(event: E, hint: Parameters<typeof scrubSentryEvent>[1]): E | null {
  const scrubbed = scrubSentryEvent(event, hint);
  const thrown = hint?.originalException;
  const held =
    scrubbed && thrown && typeof thrown === 'object' ? serverHeldTags.get(thrown) : undefined;
  if (!scrubbed || !held) return scrubbed;
  return { ...scrubbed, tags: { ...scrubbed.tags, ...held } };
}

export function initSentry(): boolean {
  if (initialized) return true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    release: sourceCommit ?? undefined,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubAndRestoreHeldTags,
  });
  initialized = true;
  return true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export { Sentry };

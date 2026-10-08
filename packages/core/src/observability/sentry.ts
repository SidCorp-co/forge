import { scrubSentryEvent } from '@forge/observability';
import * as Sentry from '@sentry/node';
import { sourceCommit } from './source-commit.js';

let initialized = false;

/** The only tags put back after the scrub withholds them: identifiers the capture site reads from the server. */
export const SERVER_HELD_TAGS = ['webhook.provider', 'webhook.slug', 'webhook.binding_id'] as const;
export type ServerHeldTag = (typeof SERVER_HELD_TAGS)[number];

const serverHeldTags = new WeakMap<object, Partial<Record<ServerHeldTag, string>>>();

/** Records the server-held `tags` to be restored on the event `captureException(error)` produces. */
export function holdServerTags(error: object, tags: Partial<Record<ServerHeldTag, string>>): void {
  const kept: Partial<Record<ServerHeldTag, string>> = {};
  for (const key of SERVER_HELD_TAGS) {
    const value = tags[key];
    if (typeof value === 'string') kept[key] = value;
  }
  serverHeldTags.set(error, kept);
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

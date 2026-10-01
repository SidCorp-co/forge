import { z } from 'zod';

const VERIFY_MOVED =
  '`verify` is no longer read off a binding or a connection: a release is proved by the production environment\'s runtime probes, `environments.<name>.verification.runtime` in the project document (`PUT /api/projects/:id/config`), each `{ type: "http", url, path, identifies: "source" }`. Send this config without `verify`.';

export const releaseChannelFields = {
  /**
   * Which box a release should PREFER, matched against `runners.labels`.
   *
   * A recommendation and not a restriction: a project whose boxes carry no
   * matching label still releases, on the pool it has (ISS-1128). `null` means
   * NOT DECLARED, which `withdrawNulls` removes rather than stores.
   */
  releaseRunnerLabel: z.string().min(1).max(60).nullish(),
  verify: z.never({ error: VERIFY_MOVED }).optional(),
  rollback: z.string().max(4000).nullish(),
};

export const RELEASE_CHANNEL_KEYS = ['releaseRunnerLabel', 'rollback'] as const;

/**
 * A key the caller sent as `null` is REMOVED, not stored as null. The
 * integrations PATCH merges, so an omitted key survives it — which left a
 * declared `releaseRunnerLabel` unremovable by any credential (ISS-1127).
 */
export function withdrawNulls(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== null));
}

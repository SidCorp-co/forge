import { z } from 'zod';

export const releaseVerifyProbeSchema = z.object({
  url: z.string().url().max(500),
  commitPath: z.string().min(1).max(200).optional(),
});

export const releaseChannelFields = {
  /**
   * Which box a release should PREFER, matched against `runners.labels`.
   *
   * A recommendation and not a restriction: a project whose boxes carry no
   * matching label still releases, on the pool it has (ISS-1128). `null` means
   * NOT DECLARED, which `withdrawNulls` removes rather than stores.
   */
  releaseRunnerLabel: z.string().min(1).max(60).nullish(),
  verify: z
    .object({
      probes: z.array(releaseVerifyProbeSchema).min(1).max(10),
      /**
       * Declared once as a deadline on the finish's polling loop, which no longer exists: the agent
       * says when to look and a finish judges what was recorded (ISS-1282). A value is refused by
       * name rather than stripped, so nobody believes a deadline was set.
       */
      timeoutSeconds: z
        .never({
          error:
            '`timeoutSeconds` is no longer a setting: a release finish no longer waits on a clock, because the agent says when Forge reads the probes (`look`). Remove it.',
        })
        .optional(),
      /** Consecutive recorded readings that must agree before a finish believes them. */
      stableReads: z.number().int().min(1).max(10).optional(),
    })
    .nullish(),
  rollback: z.string().max(4000).nullish(),
};

export const RELEASE_CHANNEL_KEYS = ['releaseRunnerLabel', 'verify', 'rollback'] as const;

/**
 * A key the caller sent as `null` is REMOVED, not stored as null. The
 * integrations PATCH merges, so an omitted key survives it — which left a
 * declared `releaseRunnerLabel` unremovable by any credential (ISS-1127).
 */
export function withdrawNulls(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== null));
}

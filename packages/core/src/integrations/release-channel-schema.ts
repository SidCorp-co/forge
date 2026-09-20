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
   * matching label still releases, on the pool it has, and records that the
   * preference went unmet (ISS-1128).
   */
  releaseRunnerLabel: z.string().min(1).max(60).optional(),
  verify: z
    .object({
      probes: z.array(releaseVerifyProbeSchema).min(1).max(10),
      timeoutSeconds: z.number().int().min(10).max(3600).optional(),
      stableReads: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
  rollback: z.string().max(4000).optional(),
};

export const RELEASE_CHANNEL_KEYS = ['releaseRunnerLabel', 'verify', 'rollback'] as const;

import { z } from 'zod';

export const releaseVerifyProbeSchema = z.object({
  url: z.string().url().max(500),
  commitPath: z.string().min(1).max(200).optional(),
});

export const releaseChannelFields = {
  /** Matched against `runners.labels`; only those boxes may run the release. */
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

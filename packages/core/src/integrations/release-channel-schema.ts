/**
 * The three config keys every provider's binding carries, whatever it
 * integrates with.
 *
 * They live in a file of their own, and not in `provider-schemas.ts`, because a
 * provider that owns a directory declares its own shapes there and would
 * otherwise have to import them back off the registry that imports it.
 */

import { z } from 'zod';

export const releaseVerifyProbeSchema = z.object({
  url: z.string().url().max(500),
  commitPath: z.string().min(1).max(200).optional(),
});

// cm:edge contract -> packages/core/src/release-batch/channel.ts — `resolveReleaseChannel` reads these three keys off `effectiveConfig(pair)` of each live deploy binding whatever its provider, so EVERY provider config schema below must spread these fields and every provider must list them in BINDING_CONFIG_KEYS. A schema that omits them strips them on PATCH (zod objects drop unknown keys) and the roster then reports the label as undeclared behind a 200 — measured on sidpeak's coolify binding 2026-09-03, and again on pixelight's epodsystem binding 2026-09-04, where it made the storefront project's release gate undeclarable.
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
  /**
   * What to do when a deploy replaces a working build with a dead one, for a
   * channel whose API cannot do it. Prose here is read by a release agent.
   */
  rollback: z.string().max(4000).optional(),
};

export const RELEASE_CHANNEL_KEYS = ['releaseRunnerLabel', 'verify', 'rollback'] as const;

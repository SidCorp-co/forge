import { z } from 'zod';
import type { HealthInput, HealthResult, RunnerAdapter } from '../types.js';

export const claudeCodeConfigSchema = z
  .object({
    skillsDir: z.string().optional(),
    claudeBinary: z.string().optional(),
    sessionTtlSec: z.number().int().positive().optional(),
  })
  .strict();

export const claudeCodeAdapter: RunnerAdapter = {
  type: 'claude-code',
  configSchema: claudeCodeConfigSchema,

  validateConfig(config) {
    const r = claudeCodeConfigSchema.safeParse(config ?? {});
    if (!r.success) return { ok: false, error: r.error.message };
    return { ok: true, config: r.data };
  },

  async health({ runner, build }: HealthInput): Promise<HealthResult> {
    // Liveness first, from `lastSeenAt` freshness; the stale-detector cron flips
    // status to offline after 90s of silence.
    if (runner.status !== 'online') {
      return { ok: false, lastError: `status=${runner.status}` };
    }
    if (!runner.lastSeenAt) {
      return { ok: false, lastError: 'no heartbeat seen' };
    }
    const ageMs = Date.now() - runner.lastSeenAt.getTime();
    if (ageMs > 90_000) {
      return { ok: false, lastError: `stale heartbeat ${Math.round(ageMs / 1000)}s` };
    }

    // A live box running superseded code is not healthy: the work it is given is
    // written against what landed (ISS-1165). `outdated` covers a box behind the
    // release and a release behind the branch. An unknown BOX did not answer for
    // itself; an unknown RELEASE is core's blind spot, not held against the box.
    if (build && (build.outdated || build.state === 'unknown')) {
      return {
        ok: false,
        lastError: build.detail,
        details: { ageMs, build: build.state, release: build.releaseState },
      };
    }
    return {
      ok: true,
      details: { ageMs, build: build?.state ?? 'unread', release: build?.releaseState ?? 'unread' },
    };
  },
};

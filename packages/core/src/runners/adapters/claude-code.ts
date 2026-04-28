import { z } from 'zod';
import { logger } from '../../logger.js';
import { deviceRoom } from '../../ws/rooms.js';
import { roomManager } from '../../ws/server.js';
import type {
  DispatchInput,
  DispatchResult,
  HealthInput,
  HealthResult,
  RunnerAdapter,
} from '../types.js';

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

  async dispatch({ job, runner }: DispatchInput): Promise<DispatchResult> {
    if (!runner.deviceId) {
      return { status: 'failed', errorReason: 'claude-code runner missing deviceId' };
    }
    roomManager.publish(deviceRoom(runner.deviceId), {
      event: 'job.assigned',
      data: {
        jobId: job.id,
        projectId: job.projectId,
        issueId: job.issueId,
        type: job.type,
        payload: job.payload,
        runnerId: runner.id,
        runnerType: runner.type,
        dispatchedAt: job.dispatchedAt.toISOString(),
      },
    });
    logger.info(
      { jobId: job.id, runnerId: runner.id, deviceId: runner.deviceId },
      'claude-code adapter: published job.assigned',
    );
    return { status: 'dispatched' };
  },

  async health({ runner }: HealthInput): Promise<HealthResult> {
    // Health derived from `lastSeenAt` freshness; the stale-detector cron
    // flips status to offline after 90s of silence. If status is already
    // online and lastSeenAt is recent, the runner is healthy.
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
    return { ok: true, details: { ageMs } };
  },
};

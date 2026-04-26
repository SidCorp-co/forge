import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { buildSkillsZipUrl } from '../skills-zip.js';
import type {
  DispatchInput,
  DispatchResult,
  HealthInput,
  HealthResult,
  QuotaResult,
  RunnerAdapter,
} from '../types.js';

export const antigravityConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    apiKey: z.string().min(1),
    workspaceId: z.string().optional(),
    callbackSecret: z.string().min(16).optional(),
    maxCostUsd: z.number().nonnegative().optional(),
    quota: z
      .object({
        remaining: z.number().nonnegative(),
        limit: z.number().nonnegative(),
        refreshedAt: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export type AntigravityConfig = z.infer<typeof antigravityConfigSchema>;

const HMAC_SECRET_BYTES = 32;

function generateCallbackSecret(): string {
  return randomBytes(HMAC_SECRET_BYTES).toString('hex');
}

export const antigravityAdapter: RunnerAdapter = {
  type: 'antigravity',
  configSchema: antigravityConfigSchema,

  validateConfig(config) {
    const r = antigravityConfigSchema.safeParse(config ?? {});
    if (!r.success) return { ok: false, error: r.error.message };
    // Mint a callback secret if not provided. Stored alongside the runner
    // config so the HMAC handler can verify inbound events.
    const out: AntigravityConfig = r.data;
    if (!out.callbackSecret) {
      out.callbackSecret = generateCallbackSecret();
    }
    return { ok: true, config: out };
  },

  async dispatch({ job, runner }: DispatchInput): Promise<DispatchResult> {
    const cfg = antigravityConfigSchema.safeParse(runner.config);
    if (!cfg.success) {
      return { status: 'failed', errorReason: 'runner config invalid' };
    }
    const config = cfg.data;
    if (config.maxCostUsd !== undefined && config.quota?.remaining !== undefined) {
      if (config.quota.remaining <= 0) {
        return { status: 'failed', errorReason: 'quota_exceeded' };
      }
    }
    const skillsZip = runner.host === 'remote' ? await buildSkillsZipUrl(runner.projectId) : null;
    const url = `${config.baseUrl.replace(/\/$/, '')}/v1/jobs`;
    const body = {
      jobId: job.id,
      type: job.type,
      prompt: (job.payload as { prompt?: unknown })?.prompt,
      payload: job.payload,
      ...(skillsZip ? { skills_zip: skillsZip.url } : {}),
      callback_url: `${process.env['CORE_PUBLIC_URL'] ?? ''}/api/runners/${runner.id}/events`,
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
          ...(config.workspaceId ? { 'x-workspace-id': config.workspaceId } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          status: 'failed',
          errorReason: `antigravity dispatch ${res.status}: ${text.slice(0, 200)}`,
        };
      }
      logger.info(
        { jobId: job.id, runnerId: runner.id, host: runner.host },
        'antigravity adapter: dispatched',
      );
      return { status: 'dispatched' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'fetch failed';
      logger.error({ err, jobId: job.id, runnerId: runner.id }, 'antigravity dispatch threw');
      return { status: 'failed', errorReason: reason };
    }
  },

  async health({ runner }: HealthInput): Promise<HealthResult> {
    const cfg = antigravityConfigSchema.safeParse(runner.config);
    if (!cfg.success) {
      return { ok: false, lastError: 'runner config invalid' };
    }
    const url = `${cfg.data.baseUrl.replace(/\/$/, '')}/v1/health`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${cfg.data.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        return { ok: false, lastError: `health ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, lastError: err instanceof Error ? err.message : 'fetch failed' };
    }
  },

  async refreshQuota({ runner }: HealthInput): Promise<QuotaResult> {
    const cfg = antigravityConfigSchema.safeParse(runner.config);
    if (!cfg.success) return {};
    const url = `${cfg.data.baseUrl.replace(/\/$/, '')}/v1/quota`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${cfg.data.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return {};
      const data = (await res.json()) as { remaining?: number; limit?: number };
      return {
        ...(typeof data.remaining === 'number' ? { remaining: data.remaining } : {}),
        ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
      };
    } catch {
      return {};
    }
  },
};

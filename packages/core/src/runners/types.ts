import { z } from 'zod';
import type { RunnerLimitReason, RunnerStatus, RunnerType } from '../db/schema.js';
import type { RunnerBuildComparison } from '../devices/build-state.js';

export const runnerCapabilitiesSchema = z
  .object({
    skills: z.array(z.string()).optional(),
    maxConcurrent: z.number().int().positive().optional(),
    gpu: z.boolean().optional(),
    cpuArch: z.string().optional(),
  })
  .catchall(z.unknown());

export type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;

/** Inverse of capabilities — what a job demands from a runner. */
export const requiredCapabilitiesSchema = z
  .object({
    skills: z.array(z.string()).optional(),
    gpu: z.boolean().optional(),
    cpuArch: z.string().optional(),
  })
  .catchall(z.unknown());

export type RequiredCapabilities = z.infer<typeof requiredCapabilitiesSchema>;

export interface Runner {
  id: string;
  projectId: string;
  type: RunnerType;
  deviceId: string | null;
  name: string;
  labels: string[];
  capabilities: RunnerCapabilities;
  config: Record<string, unknown>;
  status: RunnerStatus;
  lastSeenAt: Date | null;
  lastError: string | null;
  /** Why the runner is currently limited (rate/usage/auth), or null. */
  limitReason: RunnerLimitReason | null;
  /** Reset time for a time-based limit; null for `auth` / no limit. */
  rateLimitedUntil: Date | null;
  /** Short human-readable limit detail for the UI. */
  limitDetail: string | null;
  /** Hard-exclusion expiry after N identical box-scoped failures; null when not quarantined. */
  quarantinedUntil: Date | null;
  /** Why the runner is quarantined (the tripping preflight check), or null. */
  quarantineReason: string | null;
}

export interface DispatchInput {
  job: {
    id: string;
    projectId: string;
    issueId: string | null;
    type: string;
    payload: unknown;
    dispatchedAt: Date;
    /** `jobs.attempts` — which try this is. */
    attempts: number;
    createdBy: string;
    agentSessionId?: string | null;
    promptString?: string | null;
    systemPrompt?: string | null;
  };
  runner: Runner;
}

export interface DispatchResult {
  status: 'dispatched' | 'failed';
  errorReason?: string;
}

export interface HealthInput {
  runner: Runner;
  /**
   * What the box is running, and what it is compared against. Optional because a
   * caller that cannot read the device has nothing to say about a build (ISS-1165).
   */
  build?: RunnerBuildComparison | undefined;
}

export interface HealthResult {
  ok: boolean;
  lastError?: string;
  details?: Record<string, unknown>;
}

export interface QuotaResult {
  remaining?: number;
  limit?: number;
  details?: Record<string, unknown>;
}

export interface RunnerAdapter {
  type: RunnerType | string;
  /** Returns a Zod schema describing the `config` jsonb shape. */
  configSchema: z.ZodType;
  validateConfig(
    config: unknown,
  ): { ok: true; config: Record<string, unknown> } | { ok: false; error: string };
  health(input: HealthInput): Promise<HealthResult>;
  refreshQuota?(input: HealthInput): Promise<QuotaResult>;
}

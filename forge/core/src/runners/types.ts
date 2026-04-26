import { z } from 'zod';
import type { RunnerHost, RunnerStatus, RunnerType } from '../db/schema.js';

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
  host: RunnerHost;
  deviceId: string | null;
  name: string;
  labels: string[];
  capabilities: RunnerCapabilities;
  config: Record<string, unknown>;
  status: RunnerStatus;
  lastSeenAt: Date | null;
  lastError: string | null;
}

export interface DispatchInput {
  job: {
    id: string;
    projectId: string;
    issueId: string | null;
    type: string;
    payload: unknown;
    dispatchedAt: Date;
  };
  runner: Runner;
}

export interface DispatchResult {
  status: 'dispatched' | 'failed';
  errorReason?: string;
}

export interface HealthInput {
  runner: Runner;
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
  validateConfig(config: unknown): { ok: true; config: Record<string, unknown> } | { ok: false; error: string };
  dispatch(input: DispatchInput): Promise<DispatchResult>;
  health(input: HealthInput): Promise<HealthResult>;
  refreshQuota?(input: HealthInput): Promise<QuotaResult>;
}

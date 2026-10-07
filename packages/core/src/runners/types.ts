import { z } from 'zod';
import type { RunnerLimitReason, RunnerStatus, RunnerType } from '../db/schema.js';

/**
 * Whether a box is running the runner `main` holds. Two questions, each between
 * like things, because conflating them is how one of them lies:
 * - is this box on the PUBLISHED release? version and commit, both release stamps.
 * - is the published release the runner that LANDED? two runner-head commits.
 *
 * Only the second catches a release that was never cut, which is the shape that
 * left seven runner commits on no box while everything read healthy (ISS-1165).
 * Three answers rather than two, because "we cannot tell" is not "it is fine".
 */
export type RunnerBuildState = 'current' | 'behind' | 'unknown';

export interface RunnerBuildComparison {
  /** This box against the published release. */
  state: RunnerBuildState;
  /** The published release against the runner on the default branch. */
  releaseState: RunnerBuildState;
  /** True when either question answered `behind`. */
  outdated: boolean;
  /** One sentence naming what was compared and what it found. */
  detail: string;
}

const runnerCapabilitiesSchema = z
  .object({
    skills: z.array(z.string()).optional(),
    maxConcurrent: z.number().int().positive().optional(),
    gpu: z.boolean().optional(),
    cpuArch: z.string().optional(),
  })
  .catchall(z.unknown());

type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;

/** Inverse of capabilities — what a job demands from a runner. */
const requiredCapabilitiesSchema = z
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
  /** The next try: when core next lets work at this account; null for `auth` / no limit. */
  rateLimitedUntil: Date | null;
  /** Short human-readable limit detail for the UI. */
  limitDetail: string | null;
  /** When the account refused; null with no limit. */
  limitRefusedAt: Date | null;
  /** The reset the account printed, its claim and never the next try; null where it printed none. */
  limitPrintedResetAt: Date | null;
  /** Hard-exclusion expiry after N identical box-scoped failures; null when not quarantined. */
  quarantinedUntil: Date | null;
  /** Why the runner is quarantined (the tripping preflight check), or null. */
  quarantineReason: string | null;
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

interface QuotaResult {
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

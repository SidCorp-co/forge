// The Executor port: the long tail. Core hands a script and a snapshot of frames to an adapter that
// runs it somewhere isolated, and the answer is data (frames and capped logs), never a picture.
// This file is the port's contract only; an adapter lives under `integrations/` and no vendor type
// crosses this boundary.

import { z } from "zod";
import { ReportFrameSchema } from "./report-queries.js";

export const EXECUTION_LANGUAGES = ["python", "bash"] as const;
export type ExecutionLanguage = (typeof EXECUTION_LANGUAGES)[number];
/** `in-band` runs inside the model's own call; `invoked` is called by core and returns when done. */
export const EXECUTOR_MODES = ["invoked", "in-band"] as const;
export type ExecutorMode = (typeof EXECUTOR_MODES)[number];
export const EXECUTION_LIMITS = ["wallMs", "cpu", "memoryMb", "outputBytes"] as const;
export type ExecutionLimit = (typeof EXECUTION_LIMITS)[number];

export const ExecutionLimitsSchema = z
  .object({
    wallMs: z.number().int().min(1),
    cpu: z.number().min(0.1),
    memoryMb: z.number().int().min(16),
    outputBytes: z.number().int().min(1),
  })
  .strict();

export const ExecutionRequestSchema = z
  .object({
    language: z.enum(EXECUTION_LANGUAGES),
    script: z.string().min(1).max(100_000),
    /** A snapshot of runs the asker may read, scrubbed before it leaves. */
    inputs: z.array(ReportFrameSchema).max(8),
    limits: ExecutionLimitsSchema,
  })
  .strict();
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

export const ExecutionResultSchema = z
  .object({
    executionId: z.string().min(1),
    adapter: z.string().min(1),
    exit: z.number().int(),
    durationMs: z.number().min(0),
    /** The limit that stopped it, when one did. */
    stopped: z.enum(EXECUTION_LIMITS).optional(),
    frames: z.array(ReportFrameSchema),
    logs: z.object({ stdout: z.string(), stderr: z.string() }).strict(),
    error: z.object({ name: z.string(), message: z.string() }).strict().optional(),
  })
  .strict();
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

/** What an adapter declares about itself; a project's opt-out filters adapters by these fields. */
export const ExecutorDescriptorSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
    mode: z.enum(EXECUTOR_MODES),
    isolation: z.string().min(1),
    network: z.literal("none"),
    dataLeavesTo: z.string().min(1),
    zdrEligible: z.boolean(),
  })
  .strict();
export type ExecutorDescriptor = z.infer<typeof ExecutorDescriptorSchema>;

/** The port. An adapter is registered at boot by the process entry; nothing that consumes it imports one. */
export interface Executor extends ExecutorDescriptor {
  availableFor(project: { id: string }): boolean | Promise<boolean>;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

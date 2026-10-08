// The Executor port: the long tail. Core hands a script and a snapshot of frames to an adapter that
// runs it somewhere isolated, and the answer is data (frames and capped logs), never a picture.
// This file is the port's contract only; an adapter lives under `integrations/` and no vendor type
// crosses this boundary.

import { z } from "zod";
import type { RefusalStatuses } from "./refusal.js";
import { REPORT_RUN_KEEP_DAYS, ReportFrameSchema } from "./report-queries.js";

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

/**
 * Where an adapter's data stays with Forge: its own infrastructure, or a box the project paired.
 * Any other `dataLeavesTo` names a third party, which a project that forbids third-party processing
 * refuses.
 */
export const EXECUTOR_DATA_STAYS_WITH_FORGE = "forge";

/**
 * How every adapter hands a script its inputs and takes its frames back, so one script runs alike on
 * each: files in the sandbox's working directory, never a network call.
 */
export const EXECUTION_IO =
  'the input frames are a JSON array of { fields, rows } in the file inputs.json in the working directory, in the order the inputs were named; the script writes { "frames": [{ fields, rows }, ...] } to the file frames.json, each field { name, type: string|number|date|duration|status|ref, label, unit? }';

/** The limits one execution runs under when the caller names none. */
export const EXECUTION_DEFAULT_LIMITS = {
  wallMs: 30_000,
  cpu: 1,
  memoryMb: 512,
  outputBytes: 256_000,
} as const satisfies Record<ExecutionLimit, number>;

/** The most one execution may ask for; a limit past it is refused by name, never lowered. */
export const EXECUTION_MAX_LIMITS = {
  wallMs: 60_000,
  cpu: 2,
  memoryMb: 1024,
  outputBytes: 1_000_000,
} as const satisfies Record<ExecutionLimit, number>;

/**
 * What one turn may spend on executions: calls, wall time and output bytes together. A chat turn is
 * the turn's own credential; a REST caller has no turn, so its caps run over its credential's last
 * `EXECUTION_TURN_WINDOW_MS`. A call that would go past one is refused by name.
 */
export const EXECUTION_TURN_CAPS = {
  calls: 8,
  wallMs: 120_000,
  outputBytes: 2_000_000,
} as const;
export type ExecutionTurnCap = keyof typeof EXECUTION_TURN_CAPS;
export const EXECUTION_TURN_WINDOW_MS = 10 * 60 * 1000;

/** Each of stdout and stderr is kept to this many bytes; the rest is cut and said to be cut. */
export const EXECUTION_LOG_CAP_BYTES = 16_384;

/** An execution is kept as long as a report run, then swept. */
export const EXECUTION_KEEP_DAYS = REPORT_RUN_KEEP_DAYS;

/** The most report runs one execution takes as its input snapshot. */
export const EXECUTION_MAX_INPUTS = 8;

/**
 * The script as its fingerprint reads it: line endings, trailing whitespace, blank lines and runs of
 * spaces or tabs inside a line do not change it; a line's leading indentation (Python's blocks) does.
 * Two scripts that normalize alike are one computation asked twice (REQ-32 C5 counts them).
 */
export function normalizeScript(script: string): string {
  return script
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
      const body = line.slice(indent.length).replace(/[ \t]+/g, " ").trimEnd();
      return body === "" ? "" : `${indent.replace(/\t/g, "    ")}${body}`;
    })
    .filter((line) => line !== "")
    .join("\n");
}

/** What a model or an agent asks: a script, the runs of this turn it reads, and optional limits. */
export const ComputeRequestSchema = z
  .object({
    language: z.enum(EXECUTION_LANGUAGES),
    script: z.string().min(1).max(100_000),
    inputs: z.array(z.string().min(1).max(64)).max(EXECUTION_MAX_INPUTS),
    limits: ExecutionLimitsSchema.partial().optional(),
  })
  .strict();
export type ComputeRequest = z.infer<typeof ComputeRequestSchema>;
export const COMPUTE_REQUEST_SHAPE =
  '{ language: "python" | "bash", script, inputs: [<runId of a report run this turn made>, ...0-8], limits?: { wallMs?, cpu?, memoryMb?, outputBytes? } }';

/** What a drawn block says about the execution its frame came from, copied when it was attached. */
export const ExecutionFactsSchema = z
  .object({
    executionId: z.string().min(1),
    adapter: z.string().min(1),
    language: z.enum(EXECUTION_LANGUAGES),
    at: z.iso.datetime(),
  })
  .strict();
export type ExecutionFacts = z.infer<typeof ExecutionFactsSchema>;

/** One kept execution: the request, who asked it, and what came back, capped and scrubbed. */
export const ExecutionRecordSchema = z
  .object({
    executionId: z.string().min(1),
    projectId: z.string().min(1),
    conversationId: z.string().nullable(),
    askedBy: z.string().min(1),
    adapter: z.string().min(1),
    language: z.enum(EXECUTION_LANGUAGES),
    script: z.string(),
    scriptFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    inputRunIds: z.array(z.string()),
    limits: ExecutionLimitsSchema,
    exit: z.number().int(),
    stopped: z.enum(EXECUTION_LIMITS).nullable(),
    durationMs: z.number().min(0),
    frames: z.array(ReportFrameSchema),
    logs: z.object({ stdout: z.string(), stderr: z.string() }).strict(),
    error: z.object({ name: z.string(), message: z.string() }).strict().nullable(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

export const EXECUTION_REFUSAL_CODES = [
  "EXECUTION_REFUSED",
  "EXECUTOR_UNAVAILABLE",
  "EXECUTOR_FAILED",
  "EXECUTION_DISABLED",
  "EXECUTION_NO_ADAPTER_ALLOWED",
  "EXECUTION_DOOR_FORBIDDEN",
  "EXECUTION_LIMIT_REFUSED",
  "EXECUTION_TURN_CAP_REACHED",
  "EXECUTION_INPUT_REFUSED",
  "EXECUTION_NOT_FOUND",
  "EXECUTION_EXPIRED",
  "EXECUTION_READ_FORBIDDEN",
] as const;
export type ExecutionRefusalCode = (typeof EXECUTION_REFUSAL_CODES)[number];

export const EXECUTION_REFUSAL_STATUSES = {
  EXECUTOR_UNAVAILABLE: 503,
  EXECUTOR_FAILED: 503,
  EXECUTION_DISABLED: 403,
  EXECUTION_NO_ADAPTER_ALLOWED: 403,
  EXECUTION_LIMIT_REFUSED: 400,
  EXECUTION_NOT_FOUND: 404,
  EXECUTION_EXPIRED: 404,
} as const satisfies RefusalStatuses<ExecutionRefusalCode>;

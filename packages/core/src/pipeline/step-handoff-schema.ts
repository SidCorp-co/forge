import { z } from 'zod';
import { testResults } from '../db/schema.js';

const triageHandoff = z.object({
  step: z.literal('triage'),
  schema_version: z.literal(1),
  summary: z.string().min(1).max(2000),
  suggestedApproach: z.string().min(1).max(2000),
  complexity: z.enum(['xs', 's', 'm', 'l', 'xl']),
  risks: z.array(z.string().min(1)).max(5),
  affectedAreas: z.array(z.string().min(1)).max(10),
});

// Clarify-on-happy-path: clarify reproduces bugs / validates UX between
// triage and plan. Its handoff carries the repro evidence + root-cause
// hypothesis so plan starts from verified behavior instead of re-deriving
// the problem from the issue description.
const clarifyHandoff = z.object({
  step: z.literal('clarify'),
  schema_version: z.literal(1),
  outcome: z.enum(['reproduced', 'cannot_reproduce', 'ux_validated', 'ux_ambiguous', 'skipped']),
  // Optional: `skipped` / `cannot_reproduce` outcomes legitimately have no
  // environment to report; don't force the agent to fabricate one (would
  // bounce the handoff write on a Zod diff and burn a retry).
  environment: z.string().max(500).optional(),
  stepsVerified: z
    .array(z.object({ step: z.string().min(1), observation: z.string().min(1).max(500) }))
    .max(15),
  rootCauseHypothesis: z.string().max(2000).optional(),
  openQuestions: z.array(z.string().min(1)).max(10),
});

const planHandoff = z.object({
  step: z.literal('plan'),
  schema_version: z.literal(1),
  planSummary: z.string().min(1).max(2000),
  affectedFiles: z.array(z.string().min(1)).max(30),
  acceptanceChecklist: z.array(z.string().min(1)).max(15),
  unknowns: z.array(z.string().min(1)).max(10),
});

const codeHandoff = z.object({
  step: z.literal('code'),
  schema_version: z.literal(1),
  filesModified: z
    .array(
      z.object({
        path: z.string().min(1),
        op: z.enum(['create', 'edit', 'delete']),
      }),
    )
    .max(50),
  decisions: z.array(z.object({ what: z.string().min(1), why: z.string().min(1) })).max(10),
  verificationCommands: z.array(z.string().min(1)).max(10),
  knownLimitations: z.array(z.string().min(1)).max(5),
  commitSha: z.string().optional(),
});

const reviewHandoff = z.object({
  step: z.literal('review'),
  schema_version: z.literal(1),
  verdict: z.enum(['pass', 'needs_fix', 'no_change']),
  findings: z
    .array(
      z.object({
        file: z.string().min(1),
        severity: z.enum(['blocker', 'minor']),
        note: z.string().min(1),
      }),
    )
    .max(20),
  reviewedDiffSha: z.string().min(1),
});

const testHandoff = z
  .object({
    step: z.literal('test'),
    schema_version: z.literal(1),
    result: z.enum(testResults),
    resultReason: z.string().trim().min(1).max(500).optional(),
    failures: z.array(z.object({ test: z.string().min(1), trace: z.string().max(500) })).max(20),
    flakyTests: z.array(z.string().min(1)).max(10),
  })
  .refine((value) => value.result === 'pass' || value.result === 'fail' || !!value.resultReason, {
    message: 'resultReason is required when result is blocked_fixture or verified_by_test',
    path: ['resultReason'],
  });

const fixHandoff = z.object({
  step: z.literal('fix'),
  schema_version: z.literal(1),
  filesModified: z
    .array(
      z.object({
        path: z.string().min(1),
        op: z.enum(['create', 'edit', 'delete']),
      }),
    )
    .max(50),
  decisions: z.array(z.object({ what: z.string().min(1), why: z.string().min(1) })).max(10),
  reviewItemsResolved: z.array(z.string().min(1)).max(20),
  knownLimitations: z.array(z.string().min(1)).max(5),
});

const driveHandoff = z.object({
  step: z.literal('drive'),
  schema_version: z.literal(1),
  outcome: z.enum(['advanced', 'parked', 'blocked', 'no_change']),
  summary: z.string().min(1).max(2000),
  workDone: z.array(z.string().min(1)).max(15),
  openQuestions: z.array(z.string().min(1)).max(10),
  commitSha: z.string().optional(),
});

export const stepHandoffSchema = z.discriminatedUnion('step', [
  triageHandoff,
  clarifyHandoff,
  planHandoff,
  codeHandoff,
  reviewHandoff,
  testHandoff,
  fixHandoff,
  driveHandoff,
]);
export type StepHandoffPayload = z.infer<typeof stepHandoffSchema>;

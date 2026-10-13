import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { utf16String } from '../lib/utf16-string.js';
import { gateConditionSchema } from './gate-report.js';
import { policyCopySchema } from './policy-copy.js';
import { runCheckpointSchema } from './run-evidence.js';

export const runSessionBodySchema = z.object({
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  issueKeys: z.array(z.string().min(1)).min(1).max(16),
  name: utf16String(60).min(1),
  // Validated here rather than absorbed: a run is kernel, and a gate condition
  // this route cannot read is a contract break the box is told about by name
  // rather than a field quietly dropped. The heartbeat is the other way round,
  // and for its own stated reason (ISS-1192).
  gate: gateConditionSchema.optional(),
  // Refused by name too: the copy a run was decided under is not a field to absorb (ISS-1303).
  policy: policyCopySchema.optional(),
});

export const closeBodySchema = z.object({
  outcome: z.enum(['ended', 'killed_idle', 'died']),
  detail: utf16String(500).optional(),
  checkpoint: runCheckpointSchema.optional(),
});

export const openedRunSessionSchema = z.object({ sessionId: z.string(), runId: z.string() });

export const closedRunSessionSchema = z.object({
  alreadyTerminal: z.boolean(),
  returned: z.array(z.string()),
});

/** How many of the run's issues the record was written onto. */
export const runEvidenceSchema = z.object({ issues: z.number(), written: z.number() });

const noRunSession = fail('NOT_FOUND', 'this device has no run session with that id');

export const openRunSessionRoute = describeOperation({
  summary: 'Open the record of a run the box is about to spawn, taking a lease on each issue',
  description: 'Opening the same box run again returns the session already open for it.',
  responses: {
    200: json(openedRunSessionSchema),
    403: fail('RUNNER_NOT_ADMITTED', 'the device has no admitted runner on the project'),
    409: fail('ISSUE_LEASE_HELD', 'a live run already holds one of the issues'),
  },
});

export const closeRunSessionRoute = describeOperation({
  summary: 'Record that a run ended, returning its issues to the pool if it died',
  description: 'A `checkpoint` is written onto every issue the run held before the session closes.',
  responses: { 200: json(closedRunSessionSchema), 404: noRunSession },
});

export const reportHeldWorktree = describeOperation({
  summary: "Say on each of the run's issues that its work sits in one checkout only",
  responses: { 200: json(runEvidenceSchema), 404: noRunSession },
});

export const reportResumeChoice = describeOperation({
  summary:
    "Say on each of the run's issues what a resumed master chose to do with an inherited run",
  responses: { 200: json(runEvidenceSchema), 404: noRunSession },
});

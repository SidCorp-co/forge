import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { phaseJournalOutcomes, phaseJournalSources } from '../db/schema-journal.js';

const NOT_A_MEMBER = 'the caller holds a lower project role than the route needs';
const NO_RUN = 'no such pipeline run';

export const openedPhaseSchema = z.object({
  phase: z.string(),
  attempt: z.number(),
  startedAt: z.date(),
});

/** What a phase recorded: a commit, a note, or any other structured result. */
const phaseArtifactSchema = z.union([
  z.object({ kind: z.literal('commit'), sha: z.string(), message: z.string().optional() }),
  z.object({ kind: z.literal('note'), text: z.string() }),
  z.record(z.string(), z.unknown()),
]);

export const phaseEndedSchema = z.object({
  phase: z.string(),
  attempt: z.number(),
  outcome: z.enum(phaseJournalOutcomes),
});

export const resumePointSchema = z.object({ resumePoint: openedPhaseSchema.nullable() });

export const phaseListSchema = z.object({
  phases: z.array(
    z.object({
      phase: z.string(),
      attempt: z.number(),
      source: z.enum(phaseJournalSources),
      outcome: z.enum(phaseJournalOutcomes).nullable(),
      startedAt: z.date(),
      endedAt: z.date().nullable(),
      artifact: phaseArtifactSchema.nullable(),
    }),
  ),
});

export const startPhaseOp = describeOperation({
  summary: 'Open a phase on a run; a phase entered again gets the next attempt number',
  responses: {
    201: json(openedPhaseSchema, 'The phase as opened'),
    403: fail('FORBIDDEN', NOT_A_MEMBER),
    404: fail('NOT_FOUND', NO_RUN),
  },
});

export const endPhaseOp = describeOperation({
  summary: 'Close a phase with its outcome',
  description:
    'Answers what was sent. A phase already closed by a runner verdict is left as it is.',
  responses: {
    200: json(phaseEndedSchema, 'The phase, attempt and outcome as sent'),
    403: fail('FORBIDDEN', NOT_A_MEMBER),
    404: fail('NOT_FOUND', NO_RUN),
  },
});

export const readResumePoint = describeOperation({
  summary: 'Read the phase a dead session stopped in: the newest phase with no end',
  responses: {
    200: json(resumePointSchema, '`resumePoint` is null when every phase is closed'),
    403: fail('FORBIDDEN', NOT_A_MEMBER),
    404: fail('NOT_FOUND', NO_RUN),
  },
});

export const listRunPhases = describeOperation({
  summary: "List a run's phases in the order they started",
  responses: {
    200: json(phaseListSchema),
    403: fail('FORBIDDEN', NOT_A_MEMBER),
    404: fail('NOT_FOUND', NO_RUN),
  },
});

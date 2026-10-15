import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { pipelineRunKinds, pipelineRunStatuses } from '../db/job-vocabulary.js';
import { phaseJournalOutcomes, phaseJournalSources } from '../db/schema-journal.js';

/** One attempt of one phase, with the handoff it left, as the run journal holds it. */
export const journalAttemptSchema = z.object({
  phase: z.string(),
  attempt: z.number(),
  source: z.enum(phaseJournalSources),
  outcome: z.enum(phaseJournalOutcomes).nullable(),
  startedAt: z.date(),
  endedAt: z.date().nullable(),
  durationSeconds: z
    .number()
    .nullable()
    .describe('null while the attempt is open, and where only its handoff recorded it'),
  artifact: z.record(z.string(), z.unknown()).nullable(),
  handoff: z.record(z.string(), z.unknown()).nullable(),
  handoffAt: z.date().nullable(),
});

/** A run of the issue, its attempts in the order they started. */
export const journalRunSchema = z.object({
  runId: z.string(),
  ordinal: z.number().describe("1 for the issue's first run, counted over all of them"),
  kind: z.enum(pipelineRunKinds),
  status: z.enum(pipelineRunStatuses),
  group: z
    .array(z.string())
    .nullable()
    .describe('the issue keys a group run was opened over; null for a run of this issue alone'),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
  costUsd: z
    .number()
    .nullable()
    .describe("usage of the run's sessions, the whole group's on a group run"),
  attempts: z.array(journalAttemptSchema),
});

export const issueJournalSchema = z.object({ runs: z.array(journalRunSchema) });

export const readIssueJournal = describeOperation({
  summary: 'What each run did on an issue, newest run first, from the run journal',
  description:
    '`issueId` takes a uuid or the display key (`ISS-12`). One entry per run of the issue, newest 50: a run of the issue alone, or a group run it was opened in. Each carries its status, cost and the attempts it recorded for this issue, with when each started and ended, its outcome and the handoff it left. A run that recorded no phase answers with no attempts.',
  responses: {
    200: json(issueJournalSchema),
    400: fail('BAD_REQUEST', '`issueId` is not a uuid or a display key the project can read'),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'the key names no issue in the project'),
  },
});

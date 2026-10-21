import { z } from 'zod';
import {
  describeOperation,
  fail,
  json,
  NO_SUCH_PROJECT,
} from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { reconcileRuns } from '../db/schema.js';

const reconcileRunSchema = tableRow(reconcileRuns);

export const spawnedSchema = z.object({ runId: z.string() });
export const runListSchema = z.object({ runs: z.array(reconcileRunSchema) });
export const runOneSchema = z.object({ run: reconcileRunSchema });
export const okSchema = z.object({ ok: z.literal(true) });

const notMember = fail('FORBIDDEN', 'the caller is not a project member');
const notAdmin = fail('FORBIDDEN', 'the caller is not a project admin');
const noRun = fail('NOT_FOUND', 'the project has no such reconcile run');
const decisionRefusals = {
  400: fail('BAD_REQUEST', 'the run is not in a state that takes this decision'),
  403: notAdmin,
  404: noRun,
} as const;

export const spawnReconcile = describeOperation({
  summary: 'Start a reconcile run of one skill against one update packet',
  responses: {
    201: json(spawnedSchema, 'The run that was started'),
    400: fail(
      'C1_C5_REFUSED',
      'the context bundle failed its C1 to C5 checks; the message names the one that failed',
    ),
    403: notAdmin,
    409: fail('CONFLICT', 'a run is already active for the project, or no runner is online'),
    404: NO_SUCH_PROJECT,
  },
});

export const listReconcileRuns = describeOperation({
  summary: 'List the latest 20 reconcile runs of a project, newest first',
  responses: { 200: json(runListSchema), 403: notMember, 404: NO_SUCH_PROJECT },
});

export const readReconcileRun = describeOperation({
  summary: 'Read one reconcile run',
  responses: { 200: json(runOneSchema), 403: notMember, 404: noRun },
});

export const applyReconcile = describeOperation({
  summary: 'Apply the candidate body of a reconcile run that waits on a human',
  responses: { 200: json(okSchema, 'Applied'), ...decisionRefusals },
});

export const rejectReconcile = describeOperation({
  summary: 'Reject a reconcile run with a reason',
  responses: { 200: json(okSchema, 'Rejected'), ...decisionRefusals },
});

export const acknowledgeReconcile = describeOperation({
  summary: 'Acknowledge an escalated reconcile run, with an optional reason',
  responses: { 200: json(okSchema, 'Acknowledged'), ...decisionRefusals },
});

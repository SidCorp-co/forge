import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { pipelineControlSchema, pipelineHealthSchema } from './pipeline-control-types.js';

export const pipelineTelemetrySchema = z
  .object({
    telemetry: z.unknown(),
  })
  .strict();

export const telemetrySchema = z
  .unknown()
  .describe('Whatever the runner reported; null until it has');

const notMember = fail('FORBIDDEN', "the caller is not a member of the session's project");
const noSession = fail('NOT_FOUND', 'no such agent session, or its project');

export const readPipelineControl = describeOperation({
  summary: 'Read whether a pipeline session is paused, or null if nothing was ever set',
  responses: { 200: json(pipelineControlSchema.nullable()), 403: notMember, 404: noSession },
});

export const setPipelineControl = describeOperation({
  summary: 'Pause, resume or abort a pipeline session',
  description: 'Needs the project admin role. Resuming clears the pause reason.',
  responses: {
    200: json(pipelineControlSchema, 'The control after the change'),
    403: fail('FORBIDDEN', 'the caller is below the project admin role'),
    404: noSession,
  },
});

export const readPipelineHealth = describeOperation({
  summary: "Read a pipeline session's retry count, recovery stats and last error",
  responses: { 200: json(pipelineHealthSchema), 403: notMember, 404: noSession },
});

export const setPipelineHealth = describeOperation({
  summary: "Merge a health report into a pipeline session's health",
  responses: {
    200: json(pipelineHealthSchema, 'The health after the merge'),
    403: fail('FORBIDDEN', 'the caller is below the project member role'),
    404: noSession,
  },
});

export const readPipelineTelemetry = describeOperation({
  summary: 'Read the telemetry a runner reported for a pipeline session',
  responses: { 200: json(telemetrySchema), 403: notMember, 404: noSession },
});

export const setPipelineTelemetry = describeOperation({
  summary: 'Replace the telemetry of a pipeline session; the answer is what was stored',
  responses: {
    200: json(telemetrySchema, 'The telemetry as stored'),
    403: fail('FORBIDDEN', 'the caller is below the project member role'),
    404: noSession,
  },
});

import { z } from 'zod';
import { describeOperation, fail, json } from '../../api-reference/declare/describe.js';

export const weeklyOutcomeSchema = z.union([
  z.object({ outcome: z.literal('posted'), windowId: z.string() }),
  z.object({ outcome: z.literal('skipped'), windowId: z.string(), reason: z.string() }),
  z.object({ outcome: z.literal('failed'), windowId: z.string(), error: z.string() }),
]);

export const runAssistantWeekly = describeOperation({
  summary: "Run this project's weekly assistant reading now, for the week just ended",
  description:
    'Runs what the 04:00 UTC tick runs, for this project only, under the same window and the same already-posted check, so pressing it twice posts once. A reading that cannot be served answers `skipped` with its reason, and one that threw answers `failed` having posted the failure by name.',
  responses: {
    200: json(weeklyOutcomeSchema, 'Whether the report was posted, skipped or failed'),
    403: fail('FORBIDDEN', "the caller is not an admin of the project's organization"),
    404: fail('NOT_FOUND', 'there is no such project'),
    409: fail({
      ASSISTANT_WEEKLY_OFF: 'the project has not enabled `pipelineConfig.assistantWeekly`',
      ASSISTANT_WEEKLY_NO_AUTHOR: 'the project has no creator to post the reading as',
    }),
  },
});

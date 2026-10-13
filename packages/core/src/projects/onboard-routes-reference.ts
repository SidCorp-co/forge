import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';

export const onboardStartedSchema = z.object({ sessionId: z.string() });

export const startOnboarding = describeOperation({
  summary: 'Open the chat that builds the Project Brain',
  description:
    "Pushes the `forge-onboard` skill to the project's runner, then opens a chat session whose first turn runs it. Needs a project admin.",
  responses: {
    201: json(onboardStartedSchema, 'The chat session that is running the onboarding'),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: fail('NOT_FOUND', 'the project does not exist'),
    409: fail('NO_CLAUDE_CLIENT', 'no online Claude client or chat-capable runner for the project'),
    502: fail('DISPATCH_FAILED', 'the onboarding conversation could not be started'),
    503: fail({
      ONBOARD_SKILL_MISSING: '`forge-onboard` is not installed for this project',
      NO_SYNC_TARGET: 'no device-bound runner is available to sync `forge-onboard` to',
    }),
  },
});

import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

export const onboardStartedSchema = z.object({ sessionId: z.string() });

export const startOnboarding = describeOperation({
  summary: 'Open the chat that builds the Project Brain',
  description:
    "Opens a chat session on the project's runner whose first turn runs Forge's own `forge-onboard` instructions; a project needs no template or skill of its own for it. Needs a project admin.",
  responses: {
    201: json(onboardStartedSchema, 'The chat session that is running the onboarding'),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: fail('NOT_FOUND', 'the project does not exist'),
    409: fail({
      NO_CLAUDE_CLIENT: 'no online Claude client or chat-capable runner for the project',
      DEVICE_NOT_BOUND:
        'the device picked has no runner bound to the project, so no checkout of it to run in',
    }),
    502: fail('DISPATCH_FAILED', 'the onboarding conversation could not be started'),
    503: fail(
      'ONBOARD_SKILL_MISSING',
      "Forge's own `forge-onboard` skill was not loaded when this server started",
    ),
  },
});

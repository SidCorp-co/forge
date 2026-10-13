import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';

export const promptPreviewSchema = z.object({
  systemPrompt: z.string(),
  userPrompt: z.string(),
  blocks: z.array(
    z.object({
      id: z.enum([
        'pipeline-rules',
        'tool-reference',
        'project-config',
        'project-context',
        'forge-facts',
        'state-block',
        'mcp-servers',
        'state-extras',
      ]),
      kind: z.enum(['system', 'user']),
      chars: z.number(),
      estTokens: z.number(),
    }),
  ),
  hash: z.string(),
  resolvedFlags: z.object({
    state: z.string(),
    skillName: z.string(),
    systemPromptMode: z.enum(['append', 'replace']),
    hasUserPromptPolicyOverride: z.boolean(),
  }),
});

export const previewPrompt = describeOperation({
  summary:
    'Build the system and user prompt a runner would see for a job state, with optional overrides',
  description:
    'Read-only: nothing is saved or queued. `hash` covers both prompts, so two previews can be compared without their text.',
  responses: {
    200: json(
      promptPreviewSchema,
      'The prompts, their blocks and the flags they were resolved with',
    ),
    400: fail(
      'STATE_NOT_CLAIMABLE',
      'no runner claims a job of that state, so there is no prompt to preview',
    ),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'there is no such project, or the issue is not in it'),
  },
});

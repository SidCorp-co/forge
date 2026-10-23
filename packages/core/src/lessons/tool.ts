/**
 * `forge_lesson_confusion`: the assistant stops guessing about a lesson and reports it to the steward
 * (REQ-50 BC-5). Lessons are internal to Forge (BC-9), so no person agrees to it: it goes straight to
 * the store, raised with the assistant's agency (`assistant/agreement/write-rule.ts` passes it), and
 * holds the lesson until the steward and core settle it.
 */

import { raiseConfusionRequestSchema } from '@forge/contracts/lessons';
import { z } from 'zod';
import type { ContextScopedMcpToolFactory } from '../lib/tool.js';
import { raiseConfusion } from './confusions.js';

const input = raiseConfusionRequestSchema.extend({
  lesson: z
    .number()
    .int()
    .min(1)
    .describe('The number of the lesson that confuses you (3 for L-3).'),
});

const DESCRIPTION = [
  'Raise a confusion about one of the project lessons in your prompt, instead of guessing:',
  'two lessons conflict (kind conflict, other.lesson), a lesson contradicts a requirement or design (kind contradicts, other.ref such as REQ-12),',
  'or you cannot tell how it applies here (kind unclear).',
  'For a lesson wrongly applied to an output, use kind wrongly_applied with other.ref naming that output.',
  'Give each side in one sentence and the resolution you recommend (keep, edit with the new sentence, or retire).',
  'It goes to the steward at once, and the lesson is held until the steward settles it. Go on without the lesson; nobody has to answer it.',
].join(' ');

export const lessonConfusionTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_lesson_confusion',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:write',
  description: DESCRIPTION,
  inputSchema: z.toJSONSchema(input) as Record<string, unknown>,
  handler: async (raw: Record<string, unknown>) => {
    const { lesson, ...body } = input.parse(raw);
    const projectId = ctx.boundProjectId;
    if (!projectId) {
      throw new Error(
        'forge_lesson_confusion reports a confusion on a bound project, and this turn names none',
      );
    }
    const moved = await raiseConfusion({
      projectId,
      ref: String(lesson),
      actor: { userId: ctx.principal.userId, agency: 'agent' },
      body,
    });
    return { lesson: moved.key, status: moved.status, held: moved.status === 'held' };
  },
});

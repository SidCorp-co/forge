/**
 * `forge_lesson_confusion`: the assistant stops guessing about a lesson and asks (REQ-50 BC-5). The
 * confusion is raised as the person this turn answers, with the assistant's agency, and holds the
 * lesson until a holder of `suggestions.approve` decides it.
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
  'Give each side in one sentence and the resolution you recommend (keep, edit with the new sentence, or retire).',
  'The lesson is held until a person decides; go on without it and tell the person you raised it.',
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
        'forge_lesson_confusion raises a confusion on a bound project, and this turn names none',
      );
    }
    const view = await raiseConfusion({
      projectId,
      ref: String(lesson),
      actor: { userId: ctx.principal.userId, agency: 'agent' },
      body,
    });
    return { lesson: view.key, status: view.status, held: view.status === 'held' };
  },
});

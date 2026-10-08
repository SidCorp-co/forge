import { createFeedbackRequestSchema } from '@forge/contracts/feedback';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { type ContextScopedMcpToolFactory, refusedAnswer, zodToMcpSchema } from '../lib/tool.js';
import { addAttachment } from './attachments.js';
import { createFeedback } from './service.js';

// The chat doors' way in for a person's report or wish (owner ruling 2026-10-08): it enters as
// Feedback, and the issue it may become is a triage's act, never the chat's.
const input = z.strictObject({ projectId: z.uuid(), ...createFeedbackRequestSchema.shape });

export const forgeFeedbackTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_feedback',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:write',
  description: [
    "File a person's report or wish as Feedback (FB-n), as the person you are talking to. From a",
    'chat it is held for their agreement: core keeps it as a proposal they see as a confirm card.',
    'kind: bug (something broken or wrong), change_request (different behaviour of something that',
    'exists), idea (something new), question.',
    'Name exactly one target: `requirement` (REQ-n, the requirement it touches — find it with',
    'forge_requirements first), or `screen` (the page route), `workflow`, `release`, `endpoint`, or',
    '`issue` (ISS-n) where nothing better fits.',
    'title says the problem or the wish in the reporter’s terms; body holds what happens, where,',
    'expected vs actual, and the conversation’s link where you have one.',
    'Images the person sent in this turn are attached to it.',
  ].join(' '),
  inputSchema: zodToMcpSchema(input),
  handler: async (args) => {
    const { projectId, ...request } = input.parse(args);
    const actor = { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) };
    const filed = await createFeedback({ projectId, actor, request });
    if (!filed.ok) return refusedAnswer(filed.refusals, 'FEEDBACK_REFUSED');
    const attached: string[] = [];
    const notAttached: { name: string; why: string }[] = [];
    for (const image of ctx.turn?.images ?? []) {
      const done = await addAttachment({
        projectId,
        ref: filed.feedback.key,
        actor,
        name: image.name,
        mime: image.mime,
        contentBase64: image.dataBase64,
      });
      if (done.ok) attached.push(image.name);
      else
        notAttached.push({ name: image.name, why: done.refusals.map((r) => r.detail).join(' ') });
    }
    return {
      feedback: {
        key: filed.feedback.key,
        kind: filed.feedback.kind,
        title: filed.feedback.title,
        phase: filed.feedback.phase,
        target: filed.feedback.target,
      },
      ...(attached.length > 0 ? { attached } : {}),
      ...(notAttached.length > 0 ? { notAttached } : {}),
    };
  },
});

// `widget_propose_feedback`: the feedback widget's one tool. It proposes the Feedback item the
// visitor described, and files nothing: the visitor sees the draft in the frame and confirms or
// discards it themselves (`POST /api/widget/session/drafts/:draftId/confirm`). It reads nothing.

import { WIDGET_DRAFT_KINDS } from '@forge/contracts/widget';
import { z } from 'zod';
import { type ChatToolset, toolError } from './mcp-adapter.js';

export const WIDGET_DRAFT_TOOL = 'widget_propose_feedback';

export const widgetDraftParamsSchema = z.strictObject({
  kind: z.enum(WIDGET_DRAFT_KINDS),
  title: z.string().trim().min(3).max(120),
  did: z.string().trim().min(1).max(1000).optional(),
  saw: z.string().trim().min(1).max(2000),
  expected: z.string().trim().min(1).max(1000).optional(),
  whereSeen: z.string().trim().min(1).max(500).optional(),
});
export type WidgetDraftParams = z.infer<typeof widgetDraftParamsSchema>;

const DESCRIPTION = [
  'Propose the report the visitor described, once you know what they saw and, for a problem, what they did and what they expected.',
  'kind: bug (something does not work), change_request (works, but they want it different), idea (something new), question (they ask how something works).',
  'title: one short line in their language. did, saw, expected: their own words, summed up, never invented. whereSeen: the page or screen, from what they said or the page they are on.',
  'Nothing is filed: the visitor sees the draft with Send and Discard buttons and decides. A new proposal replaces the one waiting.',
].join(' ');

/** The widget's whole toolset: one call, which hands the draft to `propose` and reads nothing back. */
export function buildWidgetDraftToolset(
  propose: (draft: WidgetDraftParams) => Promise<{ draftId: string }>,
): ChatToolset {
  return {
    tools: [
      {
        type: 'function',
        function: {
          name: WIDGET_DRAFT_TOOL,
          description: DESCRIPTION,
          parameters: z.toJSONSchema(widgetDraftParamsSchema, { io: 'input' }) as Record<
            string,
            unknown
          >,
        },
      },
    ],
    async execute(name, argsJson) {
      if (name !== WIDGET_DRAFT_TOOL) return toolError(`there is no tool ${name} here.`);
      let raw: unknown;
      try {
        raw = argsJson.trim() ? JSON.parse(argsJson) : {};
      } catch {
        return toolError('the arguments were not valid JSON. Nothing was proposed.');
      }
      const params = widgetDraftParamsSchema.safeParse(raw);
      if (!params.success) {
        const where = params.error.issues
          .map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`)
          .join('; ');
        return toolError(`${where}. Nothing was proposed.`);
      }
      const { draftId } = await propose(params.data);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              proposed: { draftId },
              note: 'The visitor now sees this draft with Send and Discard. Ask them to check it and press Send, or to tell you what to change. Do not say it was sent.',
            }),
          },
        ],
      };
    },
    ranAs: () => null,
  };
}

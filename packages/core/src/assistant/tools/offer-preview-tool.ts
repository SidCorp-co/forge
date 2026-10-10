// `offer_preview`: the chat assistant offers to build an idea for a requirement or a feedback item as
// a live preview, a button in the thread (REQ-41 BC-14). Core reads the item and the person's
// permission before offering, so a button is only ever one the person may press; pressing it opens
// the preview in the browser as the person, through the project's preview route, which checks both
// again and places the sketch run. The tool itself opens nothing.

import {
  IDEA_CHANGE_TOOL,
  IDEA_OFFER_TOOL,
  type IdeaOffer,
  type IdeaOfferRefusalCode,
  ideaChangeParamsSchema,
  ideaOfferParamsSchema,
} from '@forge/contracts/idea-offer';
import { z } from 'zod';
import { isRefusal } from '../../lib/refusal.js';
import { actorFor, can, projectResource } from '../../permissions/index.js';
import { itemOf, openIdeaPreviewOf, sendPreviewMessage } from '../../previews/index.js';
import { type ChatToolset, toolError } from './mcp-adapter.js';

const DESCRIPTION = [
  'Offer the person a button in this conversation that builds an idea as a live preview of the product: a sketch of what they asked to see, built on a throwaway branch and shown beside this chat.',
  'Use it when they ask to see, try or sketch a change to a requirement or a feedback item (about: REQ-n or FB-n), instead of describing the change in prose.',
  'brief is what they want to see, in their words.',
  'Nothing is built until the person presses the button, and it opens with their own access. Say what the button will build; do not say it is built. They keep it from the preview when they like it.',
].join(' ');

const CHANGE_DESCRIPTION = [
  'Send a change the person asks for in this message to the idea preview they have open beside this chat (about: REQ-n or FB-n), so it shows there by hot reload within seconds.',
  'change is what they asked to change, in their words. Use it only once they have opened the preview from the button; it edits only that throwaway sketch, never the product or a record.',
].join(' ');

const refused = (code: IdeaOfferRefusalCode, text: string) =>
  toolError(`${code}: ${text} No button was offered.`);

const unsent = (code: IdeaOfferRefusalCode | string, text: string) =>
  toolError(`${code}: ${text} Nothing was sent to the preview.`);

function paramsOf<T>(
  schema: {
    safeParse(
      v: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
  },
  argsJson: string,
): { ok: true; data: T } | { ok: false; why: string } {
  let raw: unknown;
  try {
    raw = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return { ok: false, why: 'the arguments were not valid JSON.' };
  }
  const params = schema.safeParse(raw);
  if (params.success) return { ok: true, data: params.data };
  const where = params.error.issues
    .map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`)
    .join('; ');
  return { ok: false, why: `${where}.` };
}

/** Sends the change the person asked for to their open idea preview of `about` (REQ-41 BC-15). */
async function sendChange(scope: { projectId: string; userId: string }, argsJson: string) {
  const params = paramsOf(ideaChangeParamsSchema, argsJson);
  if (!params.ok) return unsent('IDEA_OFFER_INVALID', params.why);
  const { about, change } = params.data;
  const row = await openIdeaPreviewOf(scope.projectId, scope.userId, about);
  if (!row) {
    return unsent(
      'IDEA_PREVIEW_NOT_OPEN',
      `the person has no open idea preview of ${about}: offer one with ${IDEA_OFFER_TOOL} and let them press it first.`,
    );
  }
  try {
    const sent = await sendPreviewMessage(
      row.id,
      { userId: scope.userId, agency: 'agent' },
      change,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            sent: { previewId: row.id, about, seq: sent.seq },
            note: 'Sent to the sketch run; the preview beside this chat shows the edit by hot reload once the run makes it. Say it was sent, not that it is done.',
          }),
        },
      ],
    };
  } catch (err) {
    if (isRefusal(err)) return unsent(err.refusals[0]?.code ?? 'PREVIEW_REFUSED', err.message);
    throw err;
  }
}

/** The toolset that offers an idea preview on this project's requirements and feedback to the person a turn answers. */
export function buildOfferPreviewToolset(scope: {
  projectId: string;
  userId: string;
}): ChatToolset {
  return {
    tools: [
      {
        type: 'function',
        function: {
          name: IDEA_OFFER_TOOL,
          description: DESCRIPTION,
          parameters: z.toJSONSchema(ideaOfferParamsSchema, { io: 'input' }) as Record<
            string,
            unknown
          >,
        },
      },
      {
        type: 'function',
        function: {
          name: IDEA_CHANGE_TOOL,
          description: CHANGE_DESCRIPTION,
          parameters: z.toJSONSchema(ideaChangeParamsSchema, { io: 'input' }) as Record<
            string,
            unknown
          >,
        },
      },
    ],
    ranAs: () => scope.userId,
    async execute(name, argsJson) {
      if (name === IDEA_CHANGE_TOOL) return sendChange(scope, argsJson);
      const params = paramsOf(ideaOfferParamsSchema, argsJson);
      if (!params.ok) return refused('IDEA_OFFER_INVALID', params.why);
      const { about, brief } = params.data;
      const item = await itemOf(scope.projectId, about);
      if (!item) {
        return refused(
          'IDEA_OFFER_ITEM_UNKNOWN',
          `${about} is not a requirement or feedback item of this project.`,
        );
      }
      if (!(await can(actorFor(scope.userId), 'project.write', projectResource(scope.projectId)))) {
        return refused(
          'IDEA_OFFER_FORBIDDEN',
          `the person asking does not hold project.write on this project, so an idea preview of ${about} is not theirs to open.`,
        );
      }
      const offer: IdeaOffer = {
        v: 1,
        projectId: scope.projectId,
        about,
        title: item.title,
        brief,
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              offer,
              note: 'Shown to the person as a button in this conversation. Nothing is built yet: it starts only when they press it, with their own access. Say what pressing it will build; do not say it is built.',
            }),
          },
        ],
      };
    },
  };
}

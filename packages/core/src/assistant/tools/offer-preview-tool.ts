// `offer_preview`: the chat assistant offers to build an idea for a requirement or a feedback item as
// a live preview, a button in the thread (REQ-41 BC-14). Core reads the item and the person's
// permission before offering, so a button is only ever one the person may press; pressing it opens
// the preview in the browser as the person, through the project's preview route, which checks both
// again and places the sketch run. The tool itself opens nothing.

import {
  IDEA_OFFER_TOOL,
  type IdeaOffer,
  type IdeaOfferRefusalCode,
  ideaOfferParamsSchema,
} from '@forge/contracts/idea-offer';
import { z } from 'zod';
import { actorFor, can, projectResource } from '../../permissions/index.js';
import { itemOf } from '../../previews/index.js';
import { type ChatToolset, toolError } from './mcp-adapter.js';

const DESCRIPTION = [
  'Offer the person a button in this conversation that builds an idea as a live preview of the product: a sketch of what they asked to see, built on a throwaway branch and shown beside this chat.',
  'Use it when they ask to see, try or sketch a change to a requirement or a feedback item (about: REQ-n or FB-n), instead of describing the change in prose.',
  'brief is what they want to see, in their words.',
  'Nothing is built until the person presses the button, and it opens with their own access. Say what the button will build; do not say it is built. They keep it from the preview when they like it.',
].join(' ');

const refused = (code: IdeaOfferRefusalCode, text: string) =>
  toolError(`${code}: ${text} No button was offered.`);

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
    ],
    ranAs: () => scope.userId,
    async execute(_name, argsJson) {
      let raw: unknown;
      try {
        raw = argsJson.trim() ? JSON.parse(argsJson) : {};
      } catch {
        return refused('IDEA_OFFER_INVALID', 'the arguments were not valid JSON.');
      }
      const params = ideaOfferParamsSchema.safeParse(raw);
      if (!params.success) {
        const where = params.error.issues
          .map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`)
          .join('; ');
        return refused('IDEA_OFFER_INVALID', `${where}.`);
      }
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

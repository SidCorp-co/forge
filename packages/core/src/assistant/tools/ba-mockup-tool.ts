/**
 * The BA door's drawing tool (ISS-78): the assistant draws a wireframe-v1 board from the room's
 * requirement text and proposes it as a mockup of one revision; a person accepts or returns it on
 * the requirement page, and only an accepted one is pinned by the next baseline.
 */

import { MOCKUP_LIMITS } from '@forge/contracts/mockups';
import { WIREFRAME_VERSION, wireframeShapeSchema } from '@forge/contracts/wireframe';
import { z } from 'zod';
import { principalAgency } from '../../issues/index.js';
import { type ContextScopedMcpToolFactory, refusedAnswer } from '../../lib/tool.js';
import { proposeMockup } from '../../mockups/index.js';

const drawFields = {
  revision: z.number().int().min(1),
  name: z.string().trim().min(1).max(MOCKUP_LIMITS.nameChars).optional(),
  caption: z.string().trim().max(MOCKUP_LIMITS.captionChars).optional(),
};
// the board is judged by parseWireframe, whose refusal names the shape and the field
const drawInput = z.strictObject({ ...drawFields, document: z.unknown() });

/**
 * The board as the model is shown it: every shape with its own fields, so a text's size and an
 * arrow's { id } ends are read before the call rather than learnt from a refusal (forge-dev
 * 2026-10-08, REQ-36: three boards refused, a text with no w and h, arrows with bare-id or no ends).
 * A pen stroke is the person's, so it is left out; anyOf, not oneOf, for the provider's schema.
 */
const drawnShapes = wireframeShapeSchema.options.filter((o) => o.shape.type.value !== 'pen');
const shownInput = z.strictObject({
  ...drawFields,
  document: z.strictObject({
    v: z.literal(WIREFRAME_VERSION),
    title: z.string().max(200).optional(),
    shapes: z.array(z.union(drawnShapes)),
  }),
});

export const drawMockup =
  (room: { projectId: string; requirementId: string }): ContextScopedMcpToolFactory =>
  (ctx) => ({
    name: 'ba_draw_mockup',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:write',
    description: `Draw a ${WIREFRAME_VERSION} board of the screen or flow this requirement describes and propose it as a mockup of one revision (the current one, or the open draft). document is the board: { v: "${WIREFRAME_VERSION}", title?, shapes }. Every box shape (frame, text, button, input, list, image) has id, x, y, w and h on a 0..4000 canvas; an arrow joins two shapes as { from: { id }, to: { id } } (or { x, y } points) and has no box. A person accepts or returns it; MOCKUP_TYPE_INVALID names the first fault of a board that is not ${WIREFRAME_VERSION}.`,
    inputSchema: z.toJSONSchema(shownInput) as Record<string, unknown>,
    handler: async (args) => {
      const input = drawInput.parse(args);
      const outcome = await proposeMockup({
        projectId: room.projectId,
        actor: { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) },
        body: {
          target: { requirement: room.requirementId, revision: input.revision },
          kind: 'wireframe',
          document: input.document,
          name: input.name,
          caption: input.caption,
        },
      });
      // a refused board answers the refusal envelope ba_suggest answers, so its reason shows in the turn
      if (!outcome.ok) return refusedAnswer(outcome.refusals, 'MOCKUP_REFUSED');
      return {
        mockup: { key: outcome.mockup.key, status: outcome.mockup.status },
        note: 'Waiting on a person to accept or return it on the requirement page (Mockups tab).',
      };
    },
  });

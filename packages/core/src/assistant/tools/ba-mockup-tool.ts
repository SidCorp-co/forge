/**
 * The BA door's drawing tool (ISS-78): the assistant draws a wireframe-v1 board from the room's
 * requirement text and proposes it as a mockup of one revision; a person accepts or returns it on
 * the requirement page, and only an accepted one is pinned by the next baseline.
 */

import { MOCKUP_LIMITS } from '@forge/contracts/mockups';
import { WIREFRAME_VERSION } from '@forge/contracts/wireframe';
import { z } from 'zod';
import { principalAgency } from '../../issues/index.js';
import type { ContextScopedMcpToolFactory } from '../../lib/tool.js';
import { proposeMockup } from '../../mockups/service.js';

const drawInput = z.strictObject({
  revision: z.number().int().min(1),
  document: z.unknown(),
  name: z.string().trim().min(1).max(MOCKUP_LIMITS.nameChars).optional(),
  caption: z.string().trim().max(MOCKUP_LIMITS.captionChars).optional(),
});

export const drawMockup =
  (room: { projectId: string; requirementId: string }): ContextScopedMcpToolFactory =>
  (ctx) => ({
    name: 'ba_draw_mockup',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:write',
    description: `Draw a ${WIREFRAME_VERSION} board of the screen this requirement describes and propose it as a mockup of one revision (the current one, or the open draft). document is the board: { v: "${WIREFRAME_VERSION}", title?, shapes: [frame | text | button | input | list | image | arrow | pen, each with a stable id] }. A person accepts or returns it; MOCKUP_TYPE_INVALID names the first fault of a board that is not ${WIREFRAME_VERSION}.`,
    inputSchema: z.toJSONSchema(drawInput) as Record<string, unknown>,
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
      if (!outcome.ok) {
        throw new Error(
          `${outcome.refusals.map((r) => `${r.code}: ${r.detail}`).join(' | ')} — nothing was written`,
        );
      }
      return {
        mockup: { key: outcome.mockup.key, status: outcome.mockup.status },
        note: 'Waiting on a person to accept or return it on the requirement page (Mockups tab).',
      };
    },
  });

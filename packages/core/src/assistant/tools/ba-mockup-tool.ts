/**
 * The BA door's mockup tool (REQ-49 BC-5): the assistant proposes a wireframe board or an HTML page
 * of the screen the room's requirement describes, on that requirement at its open or current
 * revision, or proposes a returned one again as its next revision, settling the comments it names.
 * It waits for a person like any other mockup: accepted or returned on the requirement page or in
 * Approvals, and an accepted one is pinned by the next agree or re-pin.
 *
 * History: ISS-78 gave the door `ba_draw_mockup` (a wireframe only); ISS-459 (REQ-35) removed it when
 * a requirement's picture replaced requirement mockups. REQ-49 brings the requirement mockup back
 * beside the picture: the picture is the rough sketch shown at once, a mockup the proposal a person
 * tries, comments on and accepts.
 */

import { MOCKUP_LIMITS } from '@forge/contracts/mockups';
import { WIREFRAME_VERSION, wireframeShapeSchema } from '@forge/contracts/wireframe';
import { z } from 'zod';
import { MCP_DOOR } from '../../lib/data-egress.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  refusedAnswer,
} from '../../lib/tool.js';
import { listMockupsAs, mockupCommentsAs, proposeMockup } from '../../mockups/index.js';
import { actorOf, type BaRoom } from './ba-room.js';

const answerSchema = z.strictObject({
  comment: z.uuid(),
  note: z.string().trim().min(1).max(MOCKUP_LIMITS.commentChars).optional(),
});

const fields = {
  kind: z.enum(['wireframe', 'html']),
  name: z.string().trim().min(1).max(MOCKUP_LIMITS.nameChars).optional(),
  caption: z.string().trim().max(MOCKUP_LIMITS.captionChars).optional(),
  html: z.string().min(1).max(MOCKUP_LIMITS.bytes.html).optional(),
  revision: z.number().int().min(1).optional(),
  revises: z
    .string()
    .trim()
    .regex(/^MK-\d{1,9}$/)
    .optional(),
  answers: z.array(answerSchema).max(MOCKUP_LIMITS.answersPerRevision).optional(),
  resolves: z
    .array(answerSchema.required({ note: true }))
    .max(MOCKUP_LIMITS.answersPerRevision)
    .optional(),
};
// the board is judged by parseWireframe, whose refusal names the shape and the field
const input = z.strictObject({ ...fields, document: z.unknown().optional() });

/**
 * The board as the model is shown it: every shape with its own fields, so a text's size and an
 * arrow's { id } ends are read before the call rather than learnt from a refusal (forge-dev
 * 2026-10-08, REQ-36). A pen stroke is the person's, so it is left out; anyOf, not oneOf.
 */
const drawnShapes = wireframeShapeSchema.options.filter((o) => o.shape.type.value !== 'pen');
const shown = z.strictObject({
  ...fields,
  document: z
    .strictObject({
      v: z.literal(WIREFRAME_VERSION),
      title: z.string().max(200).optional(),
      shapes: z.array(z.union(drawnShapes)),
    })
    .optional(),
});

const DESCRIPTION = `Propose a mockup of the screen this requirement describes, on it, for a person to try, comment on and accept or return. kind wireframe sends document, a ${WIREFRAME_VERSION} board (box shapes have id, x, y, w, h on a 0..4000 canvas; an arrow joins { from: { id }, to: { id } }); kind html sends html, one self-contained page (inline CSS and script; only Google Fonts and cdnjs, jsdelivr or unpkg libraries load; it runs sandboxed and calls nothing). revision defaults to the open draft, else the current one. To answer a returned mockup, set revises (MK-n) and settle its comments: answers [{ comment, note? }] for each you changed, resolves [{ comment, note }] for each you did not. Read comments with ba_read_requirement's mockups.`;

export const proposeMockupTool =
  (room: BaRoom): ContextScopedMcpToolFactory =>
  (ctx) => ({
    name: 'ba_propose_mockup',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:write',
    description: DESCRIPTION,
    inputSchema: z.toJSONSchema(shown) as Record<string, unknown>,
    handler: async (args) => {
      const i = input.parse(args);
      const html = i.kind === 'html' ? i.html : undefined;
      const outcome = await proposeMockup({
        projectId: room.projectId,
        actor: actorOf(ctx),
        body: {
          ...(i.revises && i.revision === undefined
            ? {}
            : {
                target: {
                  requirement: room.requirementId,
                  ...(i.revision === undefined ? {} : { revision: i.revision }),
                },
              }),
          kind: i.kind,
          caption: i.caption,
          ...(i.kind === 'wireframe'
            ? { document: i.document, name: i.name }
            : {
                name: i.name ?? 'mockup.html',
                mime: 'text/html',
                ...(html ? { contentBase64: Buffer.from(html, 'utf8').toString('base64') } : {}),
              }),
          ...(i.revises ? { revises: i.revises } : {}),
          ...(i.answers?.length ? { answers: i.answers } : {}),
          ...(i.resolves?.length ? { resolves: i.resolves } : {}),
        },
      });
      // a refused proposal answers the refusal envelope ba_suggest answers, so its reason shows in the turn
      if (!outcome.ok) return refusedAnswer(outcome.refusals, 'MOCKUP_REFUSED');
      return {
        mockup: {
          key: outcome.mockup.key,
          status: outcome.mockup.status,
          round: outcome.mockup.round,
          revises: outcome.mockup.revises,
        },
        note: 'Waiting on a person to accept or return it on the requirement page or in Approvals.',
      };
    },
  });

/**
 * The mockups on the room's requirement as `ba_read_requirement` returns them: each with its status
 * and round, and on one still discussed (proposed, or returned with no next revision) its comments
 * with where each points, so a next revision can name what it answers.
 */
export async function mockupsForBa(ctx: McpContext, room: BaRoom) {
  const viewer = actorOf(ctx);
  const { mockups } = await listMockupsAs(
    viewer,
    room.projectId,
    { requirement: room.requirementId },
    MCP_DOOR,
  );
  return Promise.all(
    mockups.map(async (m) => {
      const discussed = (m.status === 'proposed' || m.status === 'returned') && !m.revisedBy;
      const comments = discussed
        ? (await mockupCommentsAs(viewer, room.projectId, m.id, MCP_DOOR)).comments.map((c) => ({
            id: c.id,
            on: c.on,
            body: c.body,
            pin: c.pin,
            settled: c.settled?.as ?? null,
          }))
        : undefined;
      return {
        key: m.key,
        kind: m.kind,
        name: m.name,
        status: m.status,
        round: m.round,
        revision: m.target.revision,
        revises: m.revises,
        revisedBy: m.revisedBy,
        reason: m.reason,
        pinned: m.pinned,
        ...(comments ? { comments } : {}),
      };
    }),
  );
}

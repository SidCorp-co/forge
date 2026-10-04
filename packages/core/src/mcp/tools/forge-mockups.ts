/**
 * `forge_mockups` — mockups MK-n (ISS-78): a wireframe board, a sketch, an image, an HTML mockup or
 * an API example proposed about exactly one requirement revision, feedback item or issue. The REST
 * routes in `mockups/routes.ts` are the same services. Every answer of this door reaches a model,
 * so a mockup's bytes are withheld on a no_egress project (surface `mockup.content`).
 */

import {
  MOCKUP_KINDS,
  MOCKUP_SOURCES,
  mockupSourceSchema,
  mockupTargetSchema,
} from '@forge/contracts/mockups';
import { WIREFRAME_VERSION } from '@forge/contracts/wireframe';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { MCP_DOOR } from '../../lib/data-egress.js';
import { getMockupAs, listMockupsAs, mockupBytes } from '../../mockups/list.js';
import type { MockupActor } from '../../mockups/read.js';
import {
  acceptMockup,
  type MockupOutcome,
  proposeMockup,
  returnMockup,
  withdrawMockup,
} from '../../mockups/service.js';
import { markUntrusted } from '../../prompt/sanitize.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalAgency,
  refusedAnswer,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const ACTIONS = ['list', 'get', 'content', 'propose', 'accept', 'return', 'withdraw'] as const;

const inputSchema = z
  .object({
    action: z.enum(ACTIONS),
    projectId: z.uuid().optional(),
    ref: z.string().trim().min(1).max(64).optional(),
    requirement: z.string().trim().min(1).max(64).optional(),
    feedback: z.string().trim().min(1).max(64).optional(),
    issue: z.string().trim().min(1).max(64).optional(),
    target: mockupTargetSchema.optional(),
    kind: z.enum(MOCKUP_KINDS).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    mime: z.string().trim().min(3).max(200).optional(),
    caption: z.string().trim().max(500).optional(),
    contentBase64: z.string().min(4).optional(),
    document: z.unknown().optional(),
    source: mockupSourceSchema.optional(),
    reason: z.string().trim().max(2_000).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const write = 'projects:write';
const GRANTS = {
  byAction: {
    list: 'projects:read',
    get: 'projects:read',
    content: 'projects:read',
    propose: write,
    accept: write,
    return: write,
    withdraw: write,
  },
} as const;

const DESCRIPTION =
  `Mockups MK-n: what a screen or a call should look like, proposed about exactly one target. Actions: ${ACTIONS.join(' | ')}. ` +
  `propose: { target: { requirement, revision } | { feedback } | { issue }, kind: ${MOCKUP_KINDS.join(' | ')}, caption?, and exactly one of ` +
  `document (a ${WIREFRAME_VERSION} board { v: "${WIREFRAME_VERSION}", title?, shapes }, kind wireframe: draw one from the requirement text), contentBase64 + name (+ mime?), or ` +
  `source { from: ${MOCKUP_SOURCES.join(' | ')}, attachmentId } (a file uploaded first with forge_uploads request) }. ` +
  'Refused by name: MOCKUP_TYPE_INVALID (a type the kind does not take, or a board that is not wireframe-v1), MOCKUP_TOO_LARGE, ' +
  "MOCKUP_SOURCE_OTHER_PROJECT (another project's upload), MOCKUP_REVISION_SUPERSEDED (propose against the head instead), " +
  'MOCKUP_TARGET_INVALID, MOCKUP_QUEUE_FULL. accept { reason? } and return { reason } take mockups.approve (project admin, or an org owner or admin), person or agent alike, ' +
  'its author included (PERMISSION_FORBIDDEN without it); withdraw is its author’s. An accepted requirement mockup is pinned by the ' +
  'next agree, re-baseline or re-pin, beside the designs, and every job on an issue of that requirement is given it. ' +
  'list: exactly one of requirement | feedback | issue. get / content: { ref: MK-n }; content returns an image as an image block and text ' +
  'inline, framed as data, and is CONTENT_EGRESS_FORBIDDEN on a no_egress project.';

function need<K extends keyof Input>(input: Input, key: K): NonNullable<Input[K]> {
  const value = input[key];
  if (value === undefined || value === null) {
    throw new Error(`BAD_REQUEST: ${input.action} needs \`${String(key)}\``);
  }
  return value as NonNullable<Input[K]>;
}

function settle(outcome: MockupOutcome) {
  if (!outcome.ok) return refusedAnswer(outcome.refusals, 'MOCKUP_REFUSED');
  return { mockup: outcome.mockup };
}

const INLINE_TEXT = new Set(['application/json', 'text/plain', 'text/html']);

async function content(actor: MockupActor, projectId: string, ref: string) {
  const file = await mockupBytes(actor, projectId, ref, MCP_DOOR);
  if (!file.ok) return refusedAnswer([file.refusal], 'MOCKUP_REFUSED');
  const { row, bytes } = file;
  const meta = { ref, kind: row.kind, name: row.name, mime: row.mime, size: row.size };
  if (row.size > env.UPLOADS_INLINE_MAX_BYTES) {
    return { ...meta, inlined: false, reason: 'too_large' };
  }
  if (row.mime.startsWith('image/') && row.mime !== 'image/svg+xml') {
    return {
      _mcpContent: [
        {
          type: 'text',
          text: markUntrusted(`Mockup image name="${row.name}" mime="${row.mime}".`, {
            source: 'mockup-metadata',
          }),
        },
        { type: 'image', data: bytes.toString('base64'), mimeType: row.mime },
      ],
      ...meta,
      inlined: false,
      reason: 'image_block_in_content',
      image: { contentIndex: 1, mimeType: row.mime },
    };
  }
  if (!INLINE_TEXT.has(row.mime) && row.mime !== 'image/svg+xml') {
    return { ...meta, inlined: false, reason: 'unsupported_inline' };
  }
  const text = markUntrusted(bytes.toString('utf8'), {
    source: `mockup name="${row.name}" mime="${row.mime}"`,
  });
  return {
    _mcpContent: [{ type: 'text', text: `Mockup text follows, framed as data:\n\n${text}` }],
    ...meta,
    inlined: true,
    text,
  };
}

async function run(args: unknown, ctx: McpContext): Promise<unknown> {
  const input = inputSchema.parse(args);
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  const actor: MockupActor = {
    userId: ctx.principal.userId,
    agency: principalAgency(ctx.principal),
  };
  switch (input.action) {
    case 'list':
      return listMockupsAs(
        actor,
        projectId,
        { requirement: input.requirement, feedback: input.feedback, issue: input.issue },
        MCP_DOOR,
      );
    case 'get':
      return { mockup: await getMockupAs(actor, projectId, need(input, 'ref'), MCP_DOOR) };
    case 'content':
      return content(actor, projectId, need(input, 'ref'));
    case 'propose':
      return settle(
        await proposeMockup({
          projectId,
          actor,
          body: {
            target: need(input, 'target'),
            kind: need(input, 'kind'),
            name: input.name,
            mime: input.mime,
            caption: input.caption,
            contentBase64: input.contentBase64,
            document: input.document,
            source: input.source,
          },
        }),
      );
    case 'accept':
      return settle(
        await acceptMockup({ projectId, ref: need(input, 'ref'), actor, reason: input.reason }),
      );
    case 'return':
      return settle(
        await returnMockup({ projectId, ref: need(input, 'ref'), actor, reason: input.reason }),
      );
    case 'withdraw':
      return settle(await withdrawMockup({ projectId, ref: need(input, 'ref'), actor }));
  }
}

export const forgeMockupsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_mockups',
  reach: 'project',
  route: '/api/projects',
  grant: GRANTS,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => run(args, ctx),
});

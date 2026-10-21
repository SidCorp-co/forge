// forge_feedback: feedback about Forge itself (REQ-47), from any project, filed as the caller's own
// account into the project the instance names as Forge's home. A project's own feedback is
// project_feedback. Every action calls what its REST twin under /api/forge/feedback calls.

import {
  type ForgeFeedbackRequest,
  forgeFeedbackRequestSchema,
  forgeFeedbackTargetSchema,
  whereSeenOf,
} from '@forge/contracts/forge-feedback';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { MCP_DOOR } from '../lib/data-egress.js';
import type { Refusal } from '../lib/refusal.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  refusedAnswer,
  zodToMcpSchema,
} from '../lib/tool.js';
import { findProjectIdBySlug } from '../projects/index.js';
import {
  type Answer,
  type ForgeDoorCaller,
  fencedProjectOfCredential,
  getForgeFeedback,
  listOwnForgeFeedback,
  submitForgeFeedback,
} from './service.js';

const ACTIONS = ['submit', 'list', 'get', 'progress'] as const;
export const FORGE_FEEDBACK_READ_ACTIONS: readonly string[] = ['list', 'get', 'progress'];

// where it was met is ONE field, `target`, never the REST body's `whereSeen` beside other optional
// ones: a model fills every optional property it is shown, so the input names as few as it can
const { whereSeen: _whereSeen, ...request } = forgeFeedbackRequestSchema.shape;

const inputSchema = z.strictObject({
  action: z.enum(ACTIONS),
  feedback: z
    .string()
    .regex(/^FB-\d{1,9}$/, 'a feedback item is named by its key, FB-n')
    .optional()
    .describe('get, progress: the item, FB-n'),
  ...request,
  kind: request.kind.optional(),
  title: request.title.optional(),
  target: forgeFeedbackTargetSchema
    .optional()
    .describe(
      'submit: the ONE place in Forge it was met — { kind: command, ref: "forge claim --next" }; kind is page (a web address), command, route (METHOD /path), tool (an MCP tool), guide, skill or other',
    ),
});

type Input = z.infer<typeof inputSchema>;

const SUBMIT_SHAPE =
  '{ kind: bug | change_request | idea | question, title, target: { kind: page | command | route | tool | guide | skill | other, ref }, body?, severity?, signalKey?, clientVersion?, from?: { project?, issue?, run? } (uuids), writtenLang? }';

/**
 * A submit call as the REST body it stands for, or the refusal naming each field that cannot stand:
 * judged whole before anything is read or written, so a call is corrected rather than half-filed.
 */
export function forgeSubmitRequestOf(
  input: Omit<Input, 'action'>,
): { ok: true; request: ForgeFeedbackRequest } | { ok: false; refusals: Refusal[] } {
  const { feedback, target, ...rest } = input;
  const refusals: Refusal[] = [];
  if (feedback !== undefined) {
    refusals.push({
      code: 'BAD_REQUEST',
      path: '/feedback',
      detail:
        'feedback names an item to get or progress; submit files a new report, so leave it out',
    });
  }
  if (!target) {
    refusals.push({
      code: 'BAD_REQUEST',
      path: '/target',
      detail: `submit names where in Forge it was met: ${SUBMIT_SHAPE}`,
    });
  }
  const parsed = forgeFeedbackRequestSchema.safeParse({
    ...rest,
    ...(target ? { whereSeen: whereSeenOf(target) } : { whereSeen: '-' }),
  });
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const path = i.path[0] === 'whereSeen' ? '/target/ref' : `/${i.path.join('/')}`;
      refusals.push({ code: 'BAD_REQUEST', path, detail: i.message });
    }
  }
  if (refusals.length > 0 || !parsed.success) return { ok: false, refusals };
  return { ok: true, request: parsed.data };
}

const DESCRIPTION = [
  'Feedback about Forge itself — its CLI, routes, MCP tools, guides, web app or pipeline — from any project you work in.',
  'It is filed into Forge’s own home project as you (your own account, person or agent), whether or not you are a member there; it never writes into the project you work in. A project’s own feedback is project_feedback.',
  `submit ${SUBMIT_SHAPE}: file it. A box credential’s live job names the project, issue and run it came from; from names them otherwise. A report whose signalKey (absent: its kind and title) an open item already holds is added to that item as an occurrence, never filed twice — the answer says created:false.`,
  'list: the items you reported, each with phase, origin and `progress` (whether work runs, who it waits on, and the forecast or why there is none; repeat `progress.says`, never a date it does not hold).',
  'get {feedback}: one item you reported (a member of the home project reads any). progress {feedback}: its progress block alone.',
  'FORGE_HOME_NOT_SET: this instance names no home project, and nothing was written. A refusal answers { error: { code, message, refusals: [{ code, path, detail }] } } and writes nothing.',
].join(' ');

const GRANT = {
  byAction: {
    submit: 'forge-feedback:write',
    list: 'forge-feedback:read',
    get: 'forge-feedback:read',
    progress: 'forge-feedback:read',
  },
} as const;

/**
 * The caller as the Forge door reads them, as REST reads them (`routes.ts:callerOf`): their account,
 * their box and the one project their credential is fenced to; and, on MCP, the project the
 * connection names, which every other tool resolves its project from.
 */
async function callerOf(ctx: McpContext): Promise<ForgeDoorCaller> {
  const slug = ctx.projectSlug;
  return {
    userId: ctx.principal.userId,
    agency: principalAgency(ctx.principal),
    deviceId: ctx.principal.deviceId,
    boundProjectId: fencedProjectOfCredential() ?? ctx.boundProjectId ?? null,
    named: slug ? { slug, id: await findProjectIdBySlug(slug) } : null,
  };
}

const PROJECT_DOOR: Refusal = {
  code: 'FORGE_FEEDBACK_PROJECT_DOOR',
  path: '/projectId',
  detail:
    "forge_feedback files feedback about Forge itself into Forge's own home project, never into a project you name, so it takes no projectId; a project's own feedback is filed with project_feedback. To say which project this report came from, send from.project.",
};

/** The call's input, or each argument that cannot stand refused by name with the valid shape. */
function inputOf(
  args: Record<string, unknown>,
): { ok: true; input: Input } | { ok: false; refusals: Refusal[] } {
  const { projectId, ...rest } = args;
  const refusals: Refusal[] = projectId === undefined ? [] : [PROJECT_DOOR];
  const parsed = inputSchema.safeParse(rest);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      refusals.push({
        code: 'BAD_REQUEST',
        path: `/${i.path.join('/')}`,
        detail: `${i.message}; forge_feedback takes { action: ${ACTIONS.join(' | ')}, feedback? } and, to submit, ${SUBMIT_SHAPE}`,
      });
    }
  }
  if (refusals.length > 0 || !parsed.success) return { ok: false, refusals };
  return { ok: true, input: parsed.data };
}

function need(input: Input): string {
  if (!input.feedback) {
    throw new Error(`BAD_REQUEST: feedback is required for ${input.action}: the item key, FB-n`);
  }
  return input.feedback;
}

const out = <T>(answer: Answer<T>) =>
  answer.ok ? answer.value : refusedAnswer(answer.refusals, 'FORGE_FEEDBACK_REFUSED');

async function submit(ctx: McpContext, input: Input) {
  const { action: _a, ...rest } = input;
  const judged = forgeSubmitRequestOf(rest);
  if (!judged.ok) return refusedAnswer(judged.refusals, 'FORGE_FEEDBACK_REFUSED');
  return out(await submitForgeFeedback(await callerOf(ctx), judged.request, MCP_DOOR));
}

async function progress(ctx: McpContext, input: Input) {
  const one = await getForgeFeedback(await callerOf(ctx), need(input), MCP_DOOR);
  if (!one.ok) return out(one);
  const { key, title, phase } = one.value;
  return { key, title, phase, progress: one.value.progress };
}

const HANDLERS = {
  submit,
  list: async (ctx: McpContext) => out(await listOwnForgeFeedback(await callerOf(ctx), MCP_DOOR)),
  get: async (ctx: McpContext, input: Input) =>
    out(await getForgeFeedback(await callerOf(ctx), need(input), MCP_DOOR)),
  progress,
} as const;

export const forgeFeedbackTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_feedback',
  reach: 'project',
  route: '/api/forge/feedback',
  grant: GRANT,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const read = inputOf(args);
    if (!read.ok) return refusedAnswer(read.refusals, 'FORGE_FEEDBACK_REFUSED');
    return HANDLERS[read.input.action](ctx, read.input);
  },
});

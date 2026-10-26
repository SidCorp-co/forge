// forge_support: a support group's session acts through this tool (REQ-75). Each action calls what
// its REST twin under /api/projects/:id/support/session calls (`acts.ts`), and only the group's own
// session, under the token its current turn was handed, is admitted.

import {
  SUPPORT_ACTIONS,
  SUPPORT_RECORD_KINDS,
  supportProposeFixRequestSchema,
  supportRecordRequestSchema,
  supportReplyRequestSchema,
  supportRunRequestSchema,
  supportSearchRequestSchema,
  supportThreadRequestSchema,
} from '@forge/contracts/support';
import { z } from 'zod';
import type { Refusal } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, refusedAnswer, zodToMcpSchema } from '../lib/tool.js';
import { type SupportActInput, supportAct } from './acts.js';
import { refusalOf } from './refusals.js';

/** The actions that write nothing: the rest post in a thread or file an item. */
export const SUPPORT_TOOL_READS: readonly string[] = ['search', 'thread', 'tools'];

/** Each action's own request, judged whole once the action is known. */
const REQUESTS = {
  search: supportSearchRequestSchema,
  thread: supportThreadRequestSchema,
  tools: z.strictObject({}),
  reply: supportReplyRequestSchema,
  run: supportRunRequestSchema,
  propose_fix: supportProposeFixRequestSchema,
  record: supportRecordRequestSchema,
} as const satisfies Record<(typeof SUPPORT_ACTIONS)[number], z.ZodType>;

// one flat strict input, every field but `action` optional, as the model is shown it: the action's
// own request then refuses a field it does not take, by name
const inputSchema = z.strictObject({
  action: z.enum(SUPPORT_ACTIONS),
  ...supportSearchRequestSchema.partial().shape,
  ...supportReplyRequestSchema.partial().shape,
  ...supportProposeFixRequestSchema.partial().shape,
  ...supportRecordRequestSchema.partial().shape,
});

const SHAPE = [
  'search { query }',
  'thread { thread }',
  'tools {}',
  'reply { thread, text }',
  'run { thread, tool, args? }',
  'propose_fix { thread, tool, args?, asker }',
  `record { thread, kind: ${SUPPORT_RECORD_KINDS.join(' | ')}, title, summary, whereSeen?, asker? }`,
].join('; ');

const DESCRIPTION = [
  'Answer a Rocket.Chat support group as its assistant. Every answer people see goes through this tool; nothing you write outside it reaches the group.',
  'search {query}: the project knowledge and its published OpenAPI contracts; each hit carries `cite`, which you put in brackets after what it supports.',
  'thread {thread}: the thread so far, oldest first. tools {}: the checks (diagnose) and changes (fix) this group grants you.',
  'reply {thread, text}: post your answer in that thread. It is screened before it is posted; a refusal names what to rewrite.',
  'run {thread, tool, args}: run a granted diagnose check; the thread is shown what was checked, and you get what came back.',
  'propose_fix {thread, tool, args, asker}: offer a granted fix to the person who asked (`from.id`). It runs only when that person confirms in the thread; you are told the result as a later message.',
  `record {thread, kind, title, summary, asker?}: what needs code or a decision is offered as Feedback for the team (kind ${SUPPORT_RECORD_KINDS.join(' | ')}); the thread is shown the route, the title and its link, and it is filed only when the asker (the thread's first writer unless named) confirms. You are told the key when it is filed; the thread is told its progress until it ships. Never promise a date.`,
  `A refusal answers { error: { code, message, refusals: [{ code, path, detail }] } } and posts nothing. Actions: ${SHAPE}.`,
].join(' ');

/** The one project a support session's token is fenced to. */
function projectOf(principal: {
  projectIds: readonly string[] | null;
  boundProjectId: string | null;
}): string | null {
  if (principal.projectIds?.length === 1) return principal.projectIds[0] ?? null;
  return principal.boundProjectId;
}

export const forgeSupportTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_support',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:write',
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const parsed = inputSchema.safeParse(args);
    const action = parsed.success ? parsed.data.action : null;
    const judged =
      parsed.success && action ? REQUESTS[action].safeParse(withoutAction(parsed.data)) : parsed;
    if (!judged.success || !action) {
      const refusals: Refusal[] = (judged.success ? [] : judged.error.issues).map((i) => ({
        code: 'BAD_REQUEST',
        path: `/${i.path.join('/')}`,
        detail: `${i.message}; forge_support takes { action: ${SUPPORT_ACTIONS.join(' | ')} } with ${SHAPE}`,
      }));
      return refusedAnswer(refusals, 'SUPPORT_REFUSED');
    }
    const projectId = projectOf(ctx.principal);
    if (!projectId) {
      return refusedAnswer(
        [
          refusalOf(
            'SUPPORT_NOT_THE_ROOM_SESSION',
            '',
            "only a support group's own session acts here, and this credential is fenced to no single project",
          ),
        ],
        'SUPPORT_REFUSED',
      );
    }
    const out = await supportAct(
      { userId: ctx.principal.userId, tokenId: ctx.principal.tokenId, projectId },
      { action, ...(judged.data as object) } as SupportActInput,
    );
    return out.ok ? out.value : refusedAnswer(out.refusals, 'SUPPORT_REFUSED');
  },
});

function withoutAction(input: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = input;
  return rest;
}

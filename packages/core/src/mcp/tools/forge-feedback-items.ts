/**
 * `forge_feedback_items` — product feedback FB-n (workflows feedback-lifecycle and feedback-triage).
 * Not `forge_feedback`, which is the deprecated alias of `forge_agent_report` (ISS-56). The REST
 * routes in `feedback/routes.ts` are the same services. Every answer of this door reaches a model,
 * so on a no_egress project it carries metadata only.
 */

import {
  createFeedbackRequestSchema,
  FEEDBACK_KINDS,
  FEEDBACK_PHASES,
  FEEDBACK_ROUTES,
  FEEDBACK_SEVERITIES,
  feedbackTriageSchema,
} from '@forge/contracts/feedback';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { askClarification } from '../../feedback/attachments.js';
import { similarFeedbackAs } from '../../feedback/embeddings.js';
import { detailAs, type FeedbackActor, listFeedbackAs, rowIn } from '../../feedback/read.js';
import {
  createFeedback,
  declineFeedback,
  type FeedbackOutcome,
  redactReporterData,
  reopenFeedback,
  verifyFeedback,
} from '../../feedback/service.js';
import { triageFeedback } from '../../feedback/triage.js';
import type { NamedRefusal } from '../../project-config/respond.js';
import { createSuggestion } from '../../suggestions/service.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalAgency,
  refusedAnswer,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const ACTIONS = [
  'list',
  'get',
  'similar',
  'create',
  'propose_triage',
  'triage',
  'decline',
  'duplicate',
  'verify',
  'reopen',
  'clarify',
  'delete_reporter_data',
] as const;

const inputSchema = z
  .object({
    action: z.enum(ACTIONS),
    projectId: z.uuid().optional(),
    /** The item: uuid or FB-n. */
    feedback: z.string().trim().min(1).max(64).optional(),
    kind: z.enum(FEEDBACK_KINDS).optional(),
    severity: z.enum(FEEDBACK_SEVERITIES).optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    whereSeen: z.string().optional(),
    requirement: z.string().optional(),
    issue: z.string().optional(),
    release: z.string().optional(),
    workflow: z.string().optional(),
    screen: z.string().optional(),
    triage: feedbackTriageSchema.optional(),
    reason: z.string().max(4_000).optional(),
    note: z.string().max(4_000).optional(),
    of: z.string().trim().min(1).max(64).optional(),
    prompt: z.string().optional(),
    needed: z.string().optional(),
    phase: z.array(z.enum(FEEDBACK_PHASES)).optional(),
    q: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const write = 'projects:write';
const GRANTS = {
  byAction: {
    list: 'projects:read',
    get: 'projects:read',
    similar: 'projects:read',
    create: write,
    propose_triage: write,
    triage: write,
    decline: write,
    duplicate: write,
    verify: write,
    reopen: write,
    clarify: write,
    delete_reporter_data: write,
  },
} as const;

const DESCRIPTION =
  'Product feedback FB-n (workflows feedback-lifecycle, feedback-triage). Not forge_feedback, which is the ' +
  `deprecated name of forge_agent_report. Actions: ${ACTIONS.join(' | ')}. ` +
  `create: { kind: ${FEEDBACK_KINDS.join(' | ')}, title, body?, severity?, whereSeen?, exactly one of requirement | issue | release | workflow | screen }; ` +
  'a target outside the project is FEEDBACK_TARGET_UNKNOWN / FEEDBACK_TARGET_NOT_IN_PROJECT, two targets FEEDBACK_TARGET_NOT_ONE. ' +
  'On a sensitive project the text is scrubbed on write; on a no_egress one every answer here carries metadata only. ' +
  `propose_triage: { feedback, triage: { route: ${FEEDBACK_ROUTES.join(' | ')}, issue? | createIssue? | suggestion? | requirement? | title? | answer? | duplicateOf?, kind?, severity?, note? } } ` +
  'writes a feedback_triage suggestion a person accepts (forge_suggestions accept); an agent proposes, never routes. ' +
  'triage / decline { reason } / duplicate { of } / verify { note? } / reopen { reason } are a person’s acts (FEEDBACK_DECIDE_FORBIDDEN, ' +
  'FEEDBACK_VERIFY_FORBIDDEN for an agent). verify only follows resolved (FEEDBACK_NOT_RESOLVED): feedback is never verified automatically. ' +
  'duplicate refuses FEEDBACK_DUPLICATE_CHAIN when the root is itself a duplicate. clarify { prompt, needed }: one open question to the ' +
  'reporter per item (FEEDBACK_CLARIFICATION_ALREADY_OPEN); its answer becomes a suggestion, never an edit. ' +
  'delete_reporter_data: a project admin person deletes text, attachments and embedding, keeping the row. ' +
  'list: { phase?, q? } answers the derived phase and who each item waits on; similar: { feedback } compares stored vectors.';

function need<K extends keyof Input>(input: Input, key: K): NonNullable<Input[K]> {
  const value = input[key];
  if (value === undefined || value === null) {
    throw new Error(`BAD_REQUEST: ${input.action} needs \`${String(key)}\``);
  }
  return value as NonNullable<Input[K]>;
}

const refusedBy = (refusals: readonly NamedRefusal[]) =>
  refusedAnswer(refusals, 'FEEDBACK_REFUSED');

async function settle(outcome: FeedbackOutcome, actor: FeedbackActor, projectId: string) {
  if (!outcome.ok) return refusedBy(outcome.refusals);
  return {
    feedback: await detailAs(actor, projectId, outcome.feedback.id, { providerBound: true }),
    ...(outcome.effect ? { effect: outcome.effect } : {}),
  };
}

async function run(args: unknown, ctx: McpContext): Promise<unknown> {
  const input = inputSchema.parse(args);
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  const actor: FeedbackActor = {
    userId: ctx.principal.userId,
    agency: principalAgency(ctx.principal),
  };
  const door = { providerBound: true };
  const item = () => need(input, 'feedback');
  switch (input.action) {
    case 'list':
      return listFeedbackAs(actor, projectId, { phases: input.phase, q: input.q }, door);
    case 'get':
      return { feedback: await detailAs(actor, projectId, item(), door) };
    case 'similar':
      return similarFeedbackAs(actor, projectId, item());
    case 'create': {
      const request = createFeedbackRequestSchema.parse({
        kind: input.kind,
        title: input.title,
        body: input.body,
        severity: input.severity,
        whereSeen: input.whereSeen,
        requirement: input.requirement,
        issue: input.issue,
        release: input.release,
        workflow: input.workflow,
        screen: input.screen,
      });
      return settle(await createFeedback({ projectId, actor, request }), actor, projectId);
    }
    case 'propose_triage': {
      const row = await rowIn(db, projectId, item());
      const outcome = await createSuggestion({
        projectId,
        actor,
        producerKind: actor.agency === 'agent' ? 'agent' : 'person',
        producerId: actor.userId,
        kind: 'feedback_triage',
        target: { feedback: row.id },
        baseRevision: null,
        payload: need(input, 'triage'),
        model: input.model ?? null,
      });
      return outcome.ok ? { suggestion: outcome.suggestion } : refusedBy(outcome.refusals);
    }
    case 'triage':
      return settle(
        await triageFeedback({
          projectId,
          ref: item(),
          actor,
          triage: need(input, 'triage'),
          channel: 'mcp',
        }),
        actor,
        projectId,
      );
    case 'duplicate':
      return settle(
        await triageFeedback({
          projectId,
          ref: item(),
          actor,
          triage: {
            route: 'duplicate',
            duplicateOf: need(input, 'of'),
            ...(input.note ? { note: input.note } : {}),
          },
          channel: 'mcp',
        }),
        actor,
        projectId,
      );
    case 'decline':
      return settle(
        await declineFeedback({ projectId, ref: item(), actor, reason: input.reason }),
        actor,
        projectId,
      );
    case 'verify':
      return settle(
        await verifyFeedback({ projectId, ref: item(), actor, note: input.note }),
        actor,
        projectId,
      );
    case 'reopen':
      return settle(
        await reopenFeedback({ projectId, ref: item(), actor, reason: input.reason }),
        actor,
        projectId,
      );
    case 'clarify':
      return settle(
        await askClarification({
          projectId,
          ref: item(),
          actor,
          prompt: need(input, 'prompt'),
          needed: need(input, 'needed'),
        }),
        actor,
        projectId,
      );
    case 'delete_reporter_data':
      return settle(await redactReporterData({ projectId, ref: item(), actor }), actor, projectId);
  }
}

export const forgeFeedbackItemsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_feedback_items',
  reach: 'project',
  grant: GRANTS,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => run(args, ctx),
});

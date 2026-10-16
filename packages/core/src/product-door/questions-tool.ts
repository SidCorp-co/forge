// `forge_questions`: the questions waiting on a person, as `/api/questions` serves them, a person's
// answer to one they owe, and a person raising one of their own on an issue (a question comment, owed
// a reply). Every action calls what its REST route calls, including who may answer with a token
// (`questions/answer-door.ts`).

import { QUESTIONS_TOOL_ACTIONS } from '@forge/contracts/mcp-product';
import { QUESTION_STATUSES } from '@forge/contracts/question-machine';
import { z } from 'zod';
import { postIssueComment } from '../comments/index.js';
import { readIssueForecast } from '../forecast/index.js';
import { findIssueById, issueDisplayIds, resolveIssueRouteRef } from '../issues/index.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from '../lib/tool.js';
import {
  ANSWER_SHAPE,
  answerBody,
  answerWithToken,
  projectQuestionsFor,
  readQuestionFor,
  readQuestionsForIssue,
  shownQuestion,
} from '../questions/index.js';
import { need, parseArgs } from './args.js';
import { actorOf, forecastViewerOf, readAccess, readerOf } from './context.js';
import { issueProgress } from './progress.js';
import { agentStatesOf } from './work.js';

const LIST_MAX = 200;

const input = z.strictObject({
  action: z.enum(QUESTIONS_TOOL_ACTIONS),
  projectId: z.uuid(),
  questionId: z.uuid().optional(),
  issue: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('an issue key (ISS-12) or uuid: list its questions, or ask on it'),
  status: z.enum(QUESTION_STATUSES).optional().describe('list: open by default'),
  limit: z.number().int().min(1).max(LIST_MAX).optional(),
  cursor: z.string().min(3).max(200).optional().describe('list: the nextCursor of the last page'),
  round: z.number().int().optional(),
  optionId: z.string().optional(),
  text: z.string().optional(),
  note: z.string().optional(),
  stillWaits: z.unknown().optional(),
  body: z.string().optional().describe('ask: your question, as the person would write it'),
  parentId: z.uuid().optional().describe('ask: the comment it replies to, if any'),
});
type Input = z.infer<typeof input>;

const SHAPE =
  '{ action, projectId, questionId?, issue?, status?, limit?, cursor?, round?, optionId? | text?, note?, stillWaits?, body?, parentId? }';

const DESCRIPTION = `Questions waiting on a person, the person's answer to one, and a person's own question on an issue.
- action=list { projectId, status?: ${QUESTION_STATUSES.join(' | ')} (open by default), issue?, limit?, cursor? }: what is owed an answer, newest first, each with its prompt, its options (locked where you may not choose one) and the recommended one. \`issue\` narrows to one issue's questions. Read \`hasMore\` and pass \`nextCursor\` back as \`cursor\` for the next page.
- action=get { projectId, questionId }: one question with every round, and \`progress\`: the issue it parks, whether work on it is running, and when it is likely done once answered.
- action=answer { projectId, questionId, round, optionId | text, note?, stillWaits? }: ${ANSWER_SHAPE}. Answer only with what the person told you in this conversation, in their words; never answer on your own reading of the question, its recommendation or the code, and when they have not said, ask them. The answer is theirs, recorded with this token and this client: it answers a question a person owes, within what they could answer signed in, and is refused PERMISSION_FORBIDDEN naming the permission an option takes that they do not hold. A question blocked on another agent is that agent's to answer: QUESTION_BLOCKED_ON_AGENT. QUESTION_NOT_OPEN: it is already answered. QUESTION_ROUND_STALE: get it again and show them the new round.
- action=ask { projectId, issue, body, parentId? }: raise your own question on an issue, as a question comment the agent working it owes a reply. To question a requirement or report a problem, use Feedback or the requirement instead: an issue is delivery work, and a question there is about that work.`;

function page(i: Input) {
  return { limit: i.limit ?? 50, cursor: i.cursor };
}

async function shownAll<Q extends Parameters<typeof shownQuestion>[1]>(
  ctx: McpContext,
  rows: readonly Q[],
) {
  return Promise.all(rows.map((q) => shownQuestion(readerOf(ctx), q)));
}

async function list(ctx: McpContext, i: Input) {
  const userId = ctx.principal.userId;
  if (i.issue) {
    const issue = await issueOf(ctx, i.projectId, i.issue);
    const seen = (await readQuestionsForIssue(issue.id, userId)) ?? [];
    const rows = seen.filter((q) => !i.status || q.status === i.status);
    return { issue: i.issue, questions: await shownAll(ctx, rows) };
  }
  const open = await projectQuestionsFor(i.projectId, userId, i.status ?? 'open', page(i));
  if (!open) throw new Error('NOT_FOUND: project not found');
  return {
    ...open,
    questions: await shownAll(
      ctx,
      open.questions as unknown as Parameters<typeof shownQuestion>[1][],
    ),
  };
}

/** The question, in the project the call names; another project's question is not found here. */
async function questionIn(ctx: McpContext, projectId: string, questionId: string) {
  const seen = await readQuestionFor(questionId, ctx.principal.userId);
  if (!seen || seen.projectId !== projectId) throw new Error('NOT_FOUND: question not found');
  return seen;
}

async function issueOf(ctx: McpContext, projectId: string, ref: string) {
  const issue = await resolveIssueRouteRef(ref, projectId, ctx.principal.userId);
  if (issue.projectId !== projectId) {
    throw new Error(`NOT_FOUND: issue ${ref} is not an issue of project ${projectId}`);
  }
  return issue;
}

/** The parked issue's progress: whether an agent works on it, and its forecast once answered. */
async function parkedProgress(ctx: McpContext, projectId: string, issueId: string | null) {
  if (!issueId) return null;
  const row = await findIssueById(issueId);
  if (!row) return null;
  const access = await readAccess(ctx, projectId);
  const [forecast, agents, keys] = await Promise.all([
    readIssueForecast(projectId, row.issSeq, forecastViewerOf(ctx, access)),
    agentStatesOf(projectId, [issueId]),
    issueDisplayIds([issueId]),
  ]);
  return {
    issue: keys.get(issueId) ?? issueId,
    title: row.title,
    status: row.status,
    ...issueProgress(forecast?.forecast ?? null, agents.get(issueId) ?? null),
  };
}

async function get(ctx: McpContext, i: Input) {
  const { questionId } = need(i, 'get', 'questionId');
  const seen = await questionIn(ctx, i.projectId, questionId);
  return {
    question: await shownQuestion(readerOf(ctx), seen),
    progress: await parkedProgress(ctx, i.projectId, seen.issueId),
  };
}

async function answer(ctx: McpContext, i: Input) {
  const { questionId } = need(i, 'answer', 'questionId');
  await questionIn(ctx, i.projectId, questionId);
  const { principal } = ctx;
  const body = parseArgs(
    answerBody,
    {
      round: i.round,
      ...(i.optionId === undefined ? {} : { optionId: i.optionId }),
      ...(i.text === undefined ? {} : { text: i.text }),
      ...(i.note === undefined ? {} : { note: i.note }),
      ...(i.stillWaits === undefined ? {} : { stillWaits: i.stillWaits }),
    },
    ANSWER_SHAPE,
  );
  return answerWithToken({
    token: {
      questionId,
      userId: principal.userId,
      agentUserId: principal.agentUserId ?? null,
      tokenId: principal.tokenId,
    },
    body,
    agency: actorOf(ctx).agency,
  });
}

async function ask(ctx: McpContext, i: Input) {
  const { issue: ref, body } = need(i, 'ask', 'issue', 'body');
  const issue = await issueOf(ctx, i.projectId, ref);
  const actor = actorOf(ctx);
  const written = await postIssueComment({
    issueId: issue.id,
    authorId: actor.userId,
    authorDeviceId: ctx.principal.deviceId ?? null,
    body,
    parentId: i.parentId,
    intent: 'question',
    declaresRecordRoute: false,
    announce: {
      actor: { type: 'user', id: actor.userId, agency: actor.agency },
      authored: actor.agency,
    },
  });
  return {
    act: 'asked',
    issue: ref,
    comment: written.row,
    owed: 'The agent working this issue owes your question a reply in its thread.',
    ...(written.warnings.length > 0 ? { warnings: written.warnings } : {}),
  };
}

const ACTIONS = { list, get, answer, ask } as const;

export const forgeQuestionsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_questions',
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(input),
  reach: 'project',
  route: ['/api/questions', '/api/issues'],
  grant: {
    byAction: {
      list: 'questions:read',
      get: 'questions:read',
      answer: 'questions:write',
      ask: 'issues:write',
    },
  },
  handler: async (args) => {
    const i = parseArgs(input, args, SHAPE);
    return ACTIONS[i.action](ctx, i);
  },
});

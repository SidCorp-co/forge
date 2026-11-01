// A parked run's question, asked and answered in a chat room by the room's own agent (ISS-857;
// owner ruling agent-is-the-voice, 2026-11-01). Core hands the agent the round as facts and posts
// only what the agent wrote, screened at the room's reply door: no line of the round, no option
// code and no outcome is composed here. The person answers in plain words ("the second one",
// "cái thứ hai"), and the agent records it through `answer_question` (`question-answer-tool.ts`). // i18n-allow: the plain answer the owner's ruling names
// A turn that cannot speak posts nothing of core's: the asking side is retried by the ledger, and
// the reading side falls back to the room's last-resort lines (`conversations/fallback-replies.ts`).

import { eq } from 'drizzle-orm';
import { CORRECTIVE_PREFIX, type ReplyLanguage } from '../../conversations/index.js';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import { isChoiceStep, type QuestionOption, type QuestionStep } from '../../db/schema-questions.js';
import { webBaseUrl } from '../../lib/web-base-url.js';
import { type MessageVerdict, refusalsOf } from '../../messaging/contract.js';
import { type ProvenMessage, proven, wholeAgentText } from '../../messaging/proven.js';
import { withRepairs } from '../../messaging/repairs.js';
import { screenReplyAtDoor } from '../../messaging/reply-screen.js';
import { runExternalChatTurn } from '../external-chat.js';
import type { ChatToolset } from '../tools/mcp-adapter.js';
import { rocketChatPersona } from './persona.js';
import { ANSWER_QUESTION_TOOL } from './question-answer-tool.js';

/** The round as the agent is told it: the run agent's own words, and what the record holds. */
export interface RoundAsked {
  issueKey: string | null;
  step: QuestionStep;
  parkDeadlineAt: Date | null;
  /** Whoever the asking turn was answering, where the question remembers. */
  askedBy: string | null;
}

/** What one turn of the room's agent came to. */
export type Spoken =
  | { kind: 'spoken'; message: ProvenMessage }
  | { kind: 'error' | 'empty'; reason: string }
  | { kind: 'held'; reason: string };

function optionFacts(o: QuestionOption, recommended: boolean): string {
  const facts: string[] = [];
  if (o.authority === 'admin') facts.push('only a project admin may choose it');
  if (o.bindsTo === 'this_call') facts.push(`binds to this one call only: ${o.fingerprint}`);
  if (o.bindsTo === 'session') facts.push('holds for this session');
  if (o.bindsTo === 'project') facts.push('holds for the whole project');
  facts.push(`carried out by the ${o.executedBy}`);
  if (recommended) facts.push('the run recommends it');
  return `- option id ${o.id}: "${o.label}" (${facts.join('; ')})`;
}

/** The round's facts, for the agent to read; none of these lines is posted. */
export function roundFacts(r: RoundAsked): string {
  const { step } = r;
  const lines = [
    `A run${r.issueKey ? ` on ${r.issueKey}` : ''} is parked until this room decides${r.askedBy ? `; it was raised while answering @${r.askedBy}` : ''}.`,
    `The question, as the run's agent wrote it: ${step.prompt}`,
  ];
  if (isChoiceStep(step)) {
    lines.push('The options:');
    for (const o of step.options) lines.push(optionFacts(o, o.id === step.recommendedOptionId));
    if (step.why) lines.push(`Why the run recommends it: ${step.why}`);
  } else {
    lines.push(`It asks for an answer in words. What would settle it: ${step.needed}`);
    if (step.recommended) lines.push(`The answer the run recommends: ${step.recommended}`);
  }
  lines.push(
    r.parkDeadlineAt
      ? `Unanswered by ${r.parkDeadlineAt.toISOString()}, the question expires and the run stays parked.`
      : 'Until somebody answers, the run stays parked.',
  );
  return lines.join('\n');
}

const ASK_BRIEF =
  'Put the question below to this room yourself, as one message in your own words and in the language the room speaks. Say plainly what is being decided and what each choice means, so a person can answer in plain words (for example "the second one"). Never ask anyone to type a code, a number format or a keyword. Do not answer it yourself, and do not say anything was decided.';

const READ_BRIEF = `A person replied in the thread where this question was asked. Read their reply. If it clearly answers the question, call ${ANSWER_QUESTION_TOOL} once, citing their message id and, for a choice, the id of the option their words pick; then tell them in your own words what was recorded. If it is unclear, picks no option, or is about something else, record nothing and ask them back in your own words. If ${ANSWER_QUESTION_TOOL} refuses, tell them why in plain words.`;

/** The persona the room's agent speaks in: the project's, as every turn in the room has it. */
async function roomPersona(projectId: string, botName?: string, asker?: string) {
  const [project] = await db
    .select({ name: projects.name, slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;
  return rocketChatPersona(project.name, asker, {
    projectSlug: project.slug,
    webBaseUrl: webBaseUrl(),
    botName,
  });
}

interface Turn {
  projectId: string;
  botName?: string | undefined;
  message: string;
  tools?: ChatToolset | undefined;
  /** The linked person the turn acts as, where one wrote; none for the asking turn. */
  userId?: string | undefined;
  asker?: string | undefined;
  replyLanguage?: ReplyLanguage | null | undefined;
}

const why = (verdict: MessageVerdict) =>
  refusalsOf(verdict)
    .map((r) => r.why)
    .join('; ');

/**
 * One turn of the room's agent over `message`, screened at the room's reply door with its one
 * repair; what it wrote as the admitted message, or why nothing may be posted.
 */
async function speak(t: Turn): Promise<Spoken> {
  const persona = await roomPersona(t.projectId, t.botName, t.asker);
  if (!persona) return { kind: 'error', reason: 'the project is gone' };
  const run = (message: string, prior?: Awaited<ReturnType<typeof runExternalChatTurn>>) =>
    runExternalChatTurn({
      projectId: t.projectId,
      adapter: 'rocketchat',
      message,
      persona,
      userId: t.userId ?? null,
      userKey: t.asker ?? null,
      replyLanguage: t.replyLanguage ?? null,
      // the rewrite reads what the first attempt did and offers no tool: an answer is recorded once
      ...(prior ? { priorRounds: prior.rounds ?? [] } : { tools: t.tools }),
    });
  let result = await run(t.message);
  if (result.terminal === 'error') return { kind: 'error', reason: result.error ?? 'turn failed' };
  const calls = [...result.toolCalls];
  if (!result.reply.trim()) return { kind: 'empty', reason: 'the agent wrote nothing' };
  const outcome = await withRepairs('chat-sync', [result.reply.trim()], {
    screen: (segments) =>
      screenReplyAtDoor('chat-sync', {
        projectId: t.projectId,
        segments,
        toolCalls: calls,
        progress: result.progress,
      }),
    rewrite: async (verdict) => {
      result = await run(
        `${CORRECTIVE_PREFIX} Your message cannot be sent as it is: ${why(verdict)}. Write it again, keeping only what you know.`,
        result,
      );
      calls.push(...result.toolCalls);
      return [result.reply.trim()];
    },
  });
  if (outcome.kind === 'exhausted') return { kind: 'held', reason: why(outcome.verdict) };
  const text = outcome.segments[0] ?? '';
  if (!text) return { kind: 'empty', reason: 'the agent wrote nothing' };
  const message = proven('chat-sync', wholeAgentText(text), outcome.verdict);
  return message
    ? { kind: 'spoken', message }
    : { kind: 'held', reason: 'the screened text could not be admitted' };
}

/** The room's agent asks the round in its own words. */
export function agentAsks(args: {
  projectId: string;
  botName?: string | undefined;
  round: RoundAsked;
}): Promise<Spoken> {
  return speak({
    projectId: args.projectId,
    botName: args.botName,
    message: `${ASK_BRIEF}\n\n${roundFacts(args.round)}`,
    asker: args.round.askedBy ?? undefined,
  });
}

/**
 * The room's agent reads a reply in the question's thread: with the tool while the round can be
 * answered, or told why it cannot (`closed`) and given no tool.
 */
export function agentReadsReply(args: {
  projectId: string;
  botName?: string | undefined;
  round: RoundAsked;
  reply: { id: string; text: string; author: string | null };
  userId?: string | undefined;
  replyLanguage: ReplyLanguage | null;
  tools: ChatToolset | null;
  closed: string | null;
}): Promise<Spoken> {
  const state = args.closed
    ? `This question cannot be answered here: ${args.closed}. Record nothing; tell the person so in your own words.`
    : READ_BRIEF;
  return speak({
    projectId: args.projectId,
    botName: args.botName,
    message: [
      state,
      '',
      roundFacts(args.round),
      '',
      `Their reply (message id ${args.reply.id}${args.reply.author ? `, from @${args.reply.author}` : ''}): ${args.reply.text}`,
    ].join('\n'),
    tools: args.tools ?? undefined,
    userId: args.userId,
    asker: args.reply.author ?? undefined,
    replyLanguage: args.replyLanguage,
  });
}

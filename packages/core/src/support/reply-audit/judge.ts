// The judge of a stored room line (ISS-1250): the one rubric (`@forge/contracts/support-reply-audit`)
// read against the line and its thread's last messages. The lines code can tell are found in code
// first, by the same detectors the pre-send screens refuse with (grant talk, a direction to a screen,
// an API-host link) and the reply-language reading; the model reads every line, and a line it fails
// counts only at the correction threshold a room reply's reading is held to (REQ-50).

import { CHAT_CORRECTION_THRESHOLD } from '@forge/contracts/lessons';
import type { SupportRoomKind } from '@forge/contracts/support-operations';
import {
  REPLY_RUBRIC,
  REPLY_RUBRIC_LINES,
  type ReplyFinding,
  type ReplyRubricLine,
  type ReplySubject,
  type ReplyVerdict,
} from '@forge/contracts/support-reply-audit';
import { z } from 'zod';
import { confidentLanguageOf } from '../../conversations/index.js';
import { permissionTalkIn } from '../permission-talk.js';
import { uiDirectionIn } from '../ui-directions.js';
import { apiHostLinkIn } from '../web-links.js';

/** One message of the thread before the judged line, oldest first. */
export interface ThreadLine {
  who: 'bot' | 'person' | 'forge';
  name?: string | null;
  text: string;
}

/**
 * Who the line answers, as the channel record holds them (`channel-store.ts:memberOf`), the row core
 * refreshes from their Forge account before each turn; null where the record holds no row for them.
 */
export interface Asker {
  name: string;
  roles: readonly string[];
  state: string;
  askFor: string | null;
}

export interface JudgeInput {
  subject: ReplySubject;
  /** The person the line answers: the last one who wrote in the thread before it. */
  asker: { name: string; record: Asker | null } | null;
  /** The line as posted, or a silence's reason. */
  text: string;
  thread: readonly ThreadLine[];
  /** The language the project's lines are held to, as a room reads it (`roomLanguage`). */
  language: 'vi' | 'en';
  roomKind: SupportRoomKind;
  /** The API's public hosts no person-facing link may point at (`web-links.ts:apiHosts`). */
  apiHosts: readonly string[];
}

const modelAnswer = z.object({
  failed: z
    .array(z.object({ line: z.enum(REPLY_RUBRIC_LINES), why: z.string().max(240) }))
    .max(REPLY_RUBRIC_LINES.length),
  confidence: z.number().min(0).max(1),
});
export type ModelJudgement = z.infer<typeof modelAnswer>;
export const MODEL_JUDGEMENT = modelAnswer;

/** The model's reading of one line, or why it gave none: the fast-model call's own answer shape. */
export type ReplyModel = (
  prompt: string,
) => Promise<
  { ok: true; value: ModelJudgement; modelId: string } | { ok: false; miss: string; detail: string }
>;

export interface Judgement {
  verdict: ReplyVerdict;
  failed: ReplyRubricLine[];
  findings: ReplyFinding[];
  model: string | null;
  miss: string | null;
  /** How sure the failing reading is: 1 for a line code found, else the model's confidence. */
  score: number;
}

const TEXT_CHARS = 3000;
const LINE_CHARS = 800;
const LANGUAGE_NAME = { vi: 'Vietnamese', en: 'English' } as const;

/** The rubric lines code tells on its own, each with the words that failed it. */
export function codeFindings(input: JudgeInput): ReplyFinding[] {
  // a silence posts nothing: its reason is Forge's record, never a person's reading
  if (input.subject === 'silence') return [];
  const found: ReplyFinding[] = [];
  const grant = permissionTalkIn(input.text);
  if (grant) found.push({ line: 'no_grant_talk', why: `it says "${grant}"`, by: 'code' });
  const direction = uiDirectionIn(input.text, input.roomKind === 'operations');
  if (direction) {
    found.push({ line: 'no_ui_directions', why: `it says "${direction}"`, by: 'code' });
  }
  const link = apiHostLinkIn(input.text, input.apiHosts);
  if (link) found.push({ line: 'web_links', why: `${link} is on the API host`, by: 'code' });
  const written = confidentLanguageOf(input.text);
  if (written && written !== input.language) {
    found.push({
      line: 'language',
      why: `it is in ${LANGUAGE_NAME[written]}, the project's lines in ${LANGUAGE_NAME[input.language]}`,
      by: 'code',
    });
  }
  return found;
}

const said = (l: ThreadLine) =>
  `${l.who === 'bot' ? 'Bot' : l.who === 'forge' ? 'Forge' : `Person${l.name ? ` (${l.name})` : ''}`}: ${l.text.slice(0, LINE_CHARS)}`;

/** Who the line answers, as the channel record says, for the asker's and the tone's lines. */
function askerLine(asker: JudgeInput['asker']): string {
  if (!asker) return 'The line answers no one person: no person wrote in the thread before it.';
  const r = asker.record;
  if (!r) return `The line answers ${asker.name}, whom the channel record does not list.`;
  return `The line answers ${asker.name}; the channel record lists their roles as ${r.roles.join(', ')} (${r.state})${r.askFor ? `, asked for: ${r.askFor}` : ''}. Whoever decides (the owner, a maintainer) is owed decisions and results, never internals or steps to do it themselves.`;
}

/** The prompt the model judges one line by: the rubric, the asker, the thread, the line. */
export function judgePrompt(input: JudgeInput): string {
  const what =
    input.subject === 'silence'
      ? 'The bot of a chat room chose to post nothing for the last message, with this reason'
      : 'The bot of a chat room posted this line in a thread';
  return [
    `${what}. Judge it against each rubric line below, reading it in the thread's context. List only the lines it fails, each with one short sentence why; an empty list when it fails none. Give your confidence from 0 to 1.`,
    `Rubric (key: what it asks):\n${REPLY_RUBRIC_LINES.map((k) => `- ${k}: ${REPLY_RUBRIC[k]}`).join('\n')}`,
    `The project's content language is ${LANGUAGE_NAME[input.language]}. The room is a ${input.roomKind} room.`,
    askerLine(input.asker),
    `Thread, oldest first:\n${input.thread.length > 0 ? input.thread.map(said).join('\n') : '(no earlier message)'}`,
    `${input.subject === 'silence' ? 'Reason for the silence' : 'The line'}:\n${input.text.slice(0, TEXT_CHARS)}`,
  ].join('\n\n');
}

/**
 * The verdict on one line: each line code found, and each the model failed at the threshold; a pass
 * where neither failed one and the model answered, unjudged where it did not and code found none.
 */
export async function judgeLine(input: JudgeInput, model: ReplyModel): Promise<Judgement> {
  const code = codeFindings(input);
  const answer = await model(judgePrompt(input));
  const sure = answer.ok && answer.value.confidence >= CHAT_CORRECTION_THRESHOLD;
  const fromModel: ReplyFinding[] = sure
    ? answer.value.failed
        .filter((f) => !code.some((c) => c.line === f.line))
        .map((f) => ({ line: f.line, why: f.why.trim() || REPLY_RUBRIC[f.line], by: 'model' }))
    : [];
  const findings = [...code, ...fromModel];
  const failed = [...new Set(findings.map((f) => f.line))];
  return {
    verdict: failed.length > 0 ? 'fail' : answer.ok ? 'pass' : 'unjudged',
    failed,
    findings,
    model: answer.ok ? answer.modelId : null,
    miss: answer.ok ? null : `${answer.miss}: ${answer.detail}`.slice(0, 300),
    score: code.length > 0 ? 1 : answer.ok ? answer.value.confidence : 0,
  };
}

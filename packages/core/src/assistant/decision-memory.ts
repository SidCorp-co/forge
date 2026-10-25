// What a conversation already holds about the decisions the chat makes for a person (REQ-41 BC-25,
// BC-28; judge K66 on ISS-624). The set the person agreed is what they could read when they said "open
// them": the reply they answered and their own latest message. Every refused decision is kept in the
// conversation itself: an `act_on_decisions` call's refused result on the turn that made it, and a
// failed card press on its follow-up (`CHAT_DECISION_CARD_BLOCK`). So a third try on one item is refused
// from either door, and its card is not drawn again.

import {
  CHAT_DECIDE_TOOL,
  CHAT_DECISION_CARD_BLOCK,
  readChatDecideResult,
} from '@forge/contracts/chat-decide';
import { needsYouDecisionsSchema } from '@forge/contracts/needs-you-decisions';
import { readMessages } from '../conversations/index.js';
import type { CallToolResult } from '../lib/tool-result.js';
import { type ChatFailure, fileChatDefect } from './agreement/refused-twice.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

/** Messages read back for a conversation's decisions: well past any one exchange about a set. */
const MESSAGES_READ = 200;
/** A range wider than this is read as its two ends: no reply agrees a hundred items by a dash. */
const RANGE_MAX = 50;
/** Tries of one decision a conversation takes before the next is refused. */
export const DECISION_TRIES_ALLOWED = 2;

const KEY = /\b([A-Z][A-Z0-9]*)-(\d+)\b/g;
const RANGE = /\b([A-Z][A-Z0-9]*)-(\d+)\s*(?:[–—-]|\.\.|to|đến)\s*(?:\1-)?(\d+)\b/g; // i18n-allow: "đến", the Vietnamese "to" of a range

/** Every item key `text` names, a range like `ISS-612–ISS-615` or `ISS-612-615` read as each key in it. */
export function keysNamedIn(text: string): Set<string> {
  const upper = text.toUpperCase();
  const keys = new Set<string>();
  for (const m of upper.matchAll(KEY)) keys.add(`${m[1]}-${Number(m[2])}`);
  for (const m of upper.matchAll(RANGE)) {
    const from = Number(m[2]);
    const to = Number(m[3]);
    if (to <= from || to - from > RANGE_MAX) continue;
    for (let n = from; n <= to; n += 1) keys.add(`${m[1]}-${n}`);
  }
  return keys;
}

/** A tool output as a turn stores it, as text: a `content` envelope is read through to its text. */
function outputText(output: unknown): string {
  if (typeof output !== 'string') return JSON.stringify(output ?? '');
  try {
    const content = (JSON.parse(output) as { content?: { text?: string }[] } | null)?.content;
    if (Array.isArray(content)) return content.map((c) => c.text ?? '').join('\n');
  } catch {
    // a plain text result, read as is
  }
  return output;
}

/** The newest reply the assistant gave in the conversation: the one the person's latest message answers. */
export async function answeredReplyOf(conversationId: string): Promise<string> {
  const messages = await readMessages(conversationId, 20);
  return messages.filter((m) => m.role === 'assistant').at(-1)?.content ?? '';
}

/** Every decision refused in the conversation, from chat or from a card, by the item key it was on. */
export async function decisionFailuresIn(
  conversationId: string,
): Promise<ReadonlyMap<string, ChatFailure[]>> {
  const out = new Map<string, ChatFailure[]>();
  const add = (key: string, f: ChatFailure) => {
    const k = key.toUpperCase();
    out.set(k, [...(out.get(k) ?? []), f]);
  };
  for (const m of await readMessages(conversationId, MESSAGES_READ)) {
    for (const b of m.blocks ?? []) {
      const call = b.type === 'tool' ? b.toolCall : undefined;
      if (!call) continue;
      if (call.name === CHAT_DECISION_CARD_BLOCK && call.isError) {
        const input = call.input ?? {};
        const key = typeof input.key === 'string' ? input.key : String(input.decision ?? '');
        const code = typeof input.code === 'string' ? input.code : 'UNNAMED';
        add(key, {
          by: `card ${String(input.decision ?? key)}`,
          code,
          detail: outputText(call.output),
        });
      } else if (call.name === CHAT_DECIDE_TOOL && !call.isError && call.output !== undefined) {
        for (const r of readChatDecideResult(outputText(call.output))?.results ?? []) {
          // only the act's own refusal: a decision not found or not agreed was never tried
          if (r.outcome !== 'refused' || r.code !== 'DECISION_REFUSED') continue;
          add(r.state?.key ?? r.decision, {
            by: `chat ${r.decision}`,
            code: r.code,
            detail: r.detail,
          });
        }
      }
    }
  }
  return out;
}

/** The conversation a turn answers in, and the person it answers. */
export interface DecisionConversation {
  projectId: string;
  conversationId: string;
  personId: string;
}

/** Files a decision tried and refused too often as a defect in Forge's own feedback. */
export function fileDecisionDefect(
  at: DecisionConversation,
  key: string,
  failures: readonly ChatFailure[],
): Promise<string> {
  return fileChatDefect({
    projectId: at.projectId,
    conversationId: at.conversationId,
    personId: at.personId,
    kindWords: 'decision',
    target: key,
    signal: 'decision',
    failures,
  });
}

/** The read's JSON with the decisions refused too often taken out, and the keys taken; null where it is not the read. */
function withheldFrom(
  text: string,
  failures: ReadonlyMap<string, ChatFailure[]>,
): { text: string; withheld: string[] } | null {
  let parsed: ReturnType<typeof needsYouDecisionsSchema.safeParse>;
  try {
    parsed = needsYouDecisionsSchema.safeParse(JSON.parse(text));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const read = parsed.data;
  const withheld: string[] = [];
  const left = read.decisions.filter((d) => {
    const key = (d.opens?.key ?? d.key).toUpperCase();
    const out = (failures.get(key)?.length ?? 0) >= DECISION_TRIES_ALLOWED;
    if (out) withheld.push(key);
    return !out;
  });
  if (withheld.length === 0) return null;
  const next = { ...read, decisions: left, total: read.total - withheld.length };
  return { text: JSON.stringify(next), withheld };
}

/**
 * The toolset with `forge_needs_you` answering without the decisions this conversation already tried
 * and saw refused twice: the cards a reply draws are read from that answer, so none is drawn a third
 * time, and each one withheld is filed as a defect once (REQ-41 BC-28).
 */
export function withTwiceRefusedDecisionsWithheld(
  toolset: ChatToolset,
  at: DecisionConversation,
): ChatToolset {
  return {
    ...toolset,
    async execute(name, argsJson) {
      const result: CallToolResult = await toolset.execute(name, argsJson);
      if (name !== 'forge_needs_you' || result.isError) return result;
      const first = result.content[0];
      if (result.content.length !== 1 || first?.type !== 'text') return result;
      const failures = await decisionFailuresIn(at.conversationId);
      const out = withheldFrom(first.text, failures);
      if (!out) return result;
      for (const key of out.withheld) {
        await fileDecisionDefect(at, key, failures.get(key) ?? []);
      }
      return { ...result, content: [{ type: 'text', text: out.text }] };
    },
  };
}

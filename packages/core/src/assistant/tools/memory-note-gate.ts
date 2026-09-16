/**
 * ISS-1064 — the gate before every `forge_memory_note` write.
 *
 * A note is one durable fact or decision worth keeping past this conversation: never the
 * person's message copied back, never one note per sentence they type, never a note about the
 * exchange itself, never a second copy of what the project already holds. The forge plugin's
 * memory-write hook asks its agents the same before a memory file lands ("record only what cost a
 * cycle, will recur, fails silently, is not already written, and code cannot hold"); the chat
 * assistant had only the tool description. `judgeNote` is pure; `memoryNotePreCall` binds it to
 * the turn loop's pre-call hook, reading the person's recent messages and the notes already kept
 * this turn from the turn itself and the project's existing notes through the dependency the door
 * hands it. A refusal is the guidance: the rule broken and one note that would pass, under 300
 * characters, so the model's next call is the fix.
 */

import type { CallToolResult } from '../../mcp/tool-result.js';
import { NEAR_DUPLICATE_THRESHOLD } from '../../memory/thresholds.js';
import type { ChatMessage } from '../providers/types.js';
import type { PreCall } from '../run-turn-core.js';
import { toolError } from './mcp-adapter.js';

/** The note tool's name as the chat model sees it (`forge_memory.note` sanitised by the adapter). */
export const NOTE_TOOL_CHAT_NAME = 'forge_memory_note';
/** The note tool's own cap on `text`; defined here so the rules import nothing that needs a database, re-exported by the tool. */
export const NOTE_TEXT_MAX = 8192;
export const NOTE_TEXT_MIN = 12;
/** The similarity at which an existing note is this note: the store's own near-duplicate threshold (D3). */
export const DUPLICATE_SCORE = NEAR_DUPLICATE_THRESHOLD;
export const REFUSAL_TEXT_MAX = 300;
/** How many of the person's recent messages the restatement rule reads. */
export const RECENT_TURNS = 6;
/** How many existing notes the duplicate rule reads, closest first. */
export const EXISTING_TOP_K = 3;
/** The marker `turn-context.ts:applyTurnContext` puts between its prefix and the person's own text. */
const CONTEXT_MARKER = '\n\n---\n\n';

export type NoteRefusalCode =
  | 'restates_message'
  | 'second_note_this_turn'
  | 'too_short'
  | 'too_long'
  | 'duplicate'
  | 'about_the_conversation';

export interface NoteRefusal {
  code: NoteRefusalCode;
  /** The rule broken, one sentence. */
  rule: string;
  /** One note that would pass, or what to do instead. */
  howToWrite: string;
}

export interface ExistingNote {
  text: string;
  /** Cosine similarity to the proposed text, 0..1. */
  score: number;
}

export interface NoteJudgeInput {
  text: string;
  title?: string | undefined;
  /** The person's recent messages, oldest first, the newest last. */
  recentTurns: readonly string[];
  /** Notes already kept in this turn (calls that were not refused). */
  notesThisTurn: number;
  /** The project's closest existing notes to `text`, with their similarity. */
  existingNotes: readonly ExistingNote[];
}

const FRAMING =
  /^\s*(?:please\s+|ok\s+|okay\s+)?(?:remember|note|keep in mind|don['’]t forget|save|store|keep)(?:\s+this|\s+that|\s+it)?(?:\s+for\s+(?:this|the|our)\s+(?:project|chat|conversation|room))?\s*[:,.-]?\s*/iu;

const ABOUT_THE_CONVERSATION =
  /^\s*(?:the\s+(?:user|person|speaker|human|customer)\s+(?:asked|said|wants|wanted|told|requested|mentioned|is asking)|(?:i|we)\s+(?:was|were|have been)\s+(?:asked|told)|in\s+this\s+(?:conversation|chat|room|thread)|(?:this|the)\s+(?:conversation|chat)\s+(?:is|was)\s+about|user\s+(?:asked|said|wants))/iu;

/** The person is changing a value already given: the duplicate rule stands aside for a note that differs from the twin (codex F2). */
const CORRECTION =
  /\b(?:correction|actually|instead|forget (?:the|that|what)|no longer|not any ?more|has changed|changed to|update[d]?:?|scratch that|rather than|is now)\b/iu;

const normalise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The person's own words in a provider message: the text after the turn-context prefix, or every text part. */
export function personText(m: ChatMessage): string {
  if (typeof m.content === 'string') {
    const at = m.content.lastIndexOf(CONTEXT_MARKER);
    return at >= 0 ? m.content.slice(at + CONTEXT_MARKER.length) : m.content;
  }
  // cm:why every text part, prefix included: a parts-array turn carries the context as its first part with no marker, and a note that restates an image-bearing message is rare enough that reading the whole beats guessing which part is the person's
  if (Array.isArray(m.content))
    return m.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ');
  return '';
}

/** The person's messages in a turn's provider history, oldest first. */
export function recentPersonTurns(
  messages: readonly ChatMessage[],
  limit = RECENT_TURNS,
): string[] {
  return messages
    .filter((m) => m.role === 'user')
    .map(personText)
    .filter((t) => t.trim().length > 0)
    .slice(-limit);
}

const sentences = (text: string): number =>
  text
    .split(/(?<=[.!?;])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

/** Whether the note is the message word for word, framing included, once both are normalised. */
const sameWords = (note: string, message: string): boolean => {
  const a = normalise(note);
  const b = normalise(message);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  const ta = new Set(a.split(' '));
  const tb = new Set(b.split(' '));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / new Set([...ta, ...tb]).size >= 0.9;
};

const firstLine = (s: string, max = 80): string => {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The rules, in the order they are read; the first one broken is the refusal. */
export function judgeNote(input: NoteJudgeInput): NoteRefusal | null {
  const text = input.text.trim();
  if (text.length < NOTE_TEXT_MIN)
    return {
      code: 'too_short',
      rule: `a note carries the fact itself, at least ${NOTE_TEXT_MIN} characters.`,
      howToWrite: 'Release code name: bench-1a2b3c.',
    };
  if (text.length > NOTE_TEXT_MAX)
    return {
      code: 'too_long',
      rule: `a note is one fact, under ${NOTE_TEXT_MAX} characters, not a transcript.`,
      howToWrite: firstLine(text, 60) || 'One sentence with the value in it.',
    };
  if (ABOUT_THE_CONVERSATION.test(text))
    return {
      code: 'about_the_conversation',
      rule: 'a note is about the project, not about this exchange or what the person asked you.',
      howToWrite:
        text
          .replace(ABOUT_THE_CONVERSATION, '')
          .replace(/^\s*(?:me\s+|us\s+)?(?:to|that)\s+/iu, '')
          .trim() || 'The fact they gave you, stated once.',
    };
  const newest = input.recentTurns.at(-1) ?? '';
  // cm:guard the framed message the note copies may be an earlier one, not the newest: "Remember: X" then "Thanks." then a note of "Remember: X" is still the request copied back (codex F1, third pass)
  const copied = input.recentTurns.find((m) => FRAMING.test(m) && sameWords(text, m));
  if (copied) {
    const fact = copied.replace(FRAMING, '').trim();
    return {
      code: 'restates_message',
      rule: 'the note is the message copied back; keep the fact, not the request to remember it.',
      howToWrite: fact.length >= NOTE_TEXT_MIN ? fact : 'The value they gave, as one sentence.',
    };
  }
  // cm:why one note per sentence the person stated, at least one: a one-sentence turn carries one fact and a second note is a copy or a split, and a longer message may carry as many facts as sentences (D4)
  const stated = Math.max(1, sentences(newest));
  if (input.notesThisTurn >= stated)
    return {
      code: 'second_note_this_turn',
      rule:
        stated === 1
          ? 'this turn stated one thing and a note already holds it; one fact, one note.'
          : `this turn stated ${stated} things and ${input.notesThisTurn} notes already hold them; one fact, one note.`,
      howToWrite:
        'Keep no further note this turn; a new fact in a later message earns its own note.',
    };
  const twin = [...input.existingNotes].sort((a, b) => b.score - a.score)[0];
  // cm:guard a correction is not a duplicate: "the code name is X2, forget the first one" scores above the threshold against the note holding X1, and refusing it would freeze the wrong value in the store; the twin word for word is still refused, correction or not (codex F2)
  // cm:guard exact words, not the 0.9 overlap `sameWords` reads: a long note whose one changed word is the correction overlaps its twin above 0.9 and would be refused as the value it replaces (codex F2, third pass)
  const correcting = CORRECTION.test(newest) && !(twin && normalise(text) === normalise(twin.text));
  if (twin && twin.score >= DUPLICATE_SCORE && !correcting)
    return {
      code: 'duplicate',
      rule: `the project already holds this (${twin.score.toFixed(2)}): "${firstLine(twin.text)}".`,
      howToWrite: 'Nothing, unless the value changed; then state the new value once.',
    };
  return null;
}

/** The refusal as the model reads it: the rule, then one passing example; under {@link REFUSAL_TEXT_MAX}. */
/** Codes a rewrite can clear in the same turn; the others say what to do instead (codex F2). */
const REWRITABLE: ReadonlySet<NoteRefusalCode> = new Set([
  'restates_message',
  'too_short',
  'too_long',
  'about_the_conversation',
]);

export function refusalText(r: NoteRefusal): string {
  const head = `Not kept (${r.code}): ${r.rule} ${REWRITABLE.has(r.code) ? 'Write instead' : 'Do this'}: `;
  const room = REFUSAL_TEXT_MAX - head.length - 2;
  const example = r.howToWrite.length > room ? `${r.howToWrite.slice(0, room - 1)}…` : r.howToWrite;
  return `${head}"${example}"`;
}

export interface MemoryNoteGateDeps {
  /** The project's closest notes to the text, closest first; a rejection reads as none and is reported. */
  existingNotes: (text: string) => Promise<ExistingNote[]>;
  onSearchError?: ((err: unknown) => void) | undefined;
}

/** The pre-call hook for the turn loop: fires for the note tool alone, refuses through `toolError`, lets everything else through. */
export function memoryNotePreCall(deps: MemoryNoteGateDeps): PreCall {
  return async (call, ctx): Promise<CallToolResult | null> => {
    if (call.name !== NOTE_TOOL_CHAT_NAME) return null;
    let args: { text?: unknown; title?: unknown };
    try {
      args = JSON.parse(call.arguments || '{}') as { text?: unknown; title?: unknown };
    } catch {
      return null; // the tool's own schema names the malformed call
    }
    const text = typeof args.text === 'string' ? args.text : '';
    const title = typeof args.title === 'string' ? args.title : undefined;
    let existingNotes: ExistingNote[] = [];
    // cm:guard a search that throws reads as no existing notes, reported and never fatal: a gate that refused every note while embeddings were down would be a silence dressed as a rule (D3)
    try {
      existingNotes = await deps.existingNotes(text);
    } catch (err) {
      deps.onSearchError?.(err);
    }
    const refusal = judgeNote({
      text,
      title,
      recentTurns: recentPersonTurns(ctx.messages),
      notesThisTurn: ctx.toolCalls.filter((c) => c.name === NOTE_TOOL_CHAT_NAME && !c.isError)
        .length,
      existingNotes,
    });
    return refusal ? toolError(refusalText(refusal)) : null;
  };
}

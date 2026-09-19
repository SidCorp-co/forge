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
  | 'unasked'
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

/** An ask to keep something, anywhere in a message: the framing above unanchored, plus the ways a person says it mid-sentence. */
const ASKED =
  /\b(?:remember|store|save|note(?=\s*(?::|that|this|down|it|for))|keep (?:in mind|this|that|a note)|don['’]t forget|for the record|write (?:this|that|it) down|make a note|take a note|memori[sz]e)\b/iu;

/** A standing request that covers what follows: it exempts later statements, an ask about one thing does not (codex F1, fifth pass). */
const STANDING =
  /\b(?:remember|note|keep (?:track|notes?) of|write down|memori[sz]e)\s+(?:everything|all|anything|whatever|what)\s+(?:i|we)\s+(?:say|tell|mention|give)\b|\bfrom (?:here|now) on,?\s+(?:remember|note|keep)\b/iu;

/** The share of the note's words the asking message carries: an ask covers a fact it names. */
const covers = (message: string, text: string): boolean => {
  const want = new Set(
    normalise(text)
      .split(' ')
      .filter((t) => t.length > 2),
  );
  if (want.size === 0) return false;
  const have = new Set(normalise(message).split(' '));
  let shared = 0;
  for (const t of want) if (have.has(t)) shared += 1;
  return shared / want.size >= 0.5;
};

/** A decision or a standing preference is worth keeping whether or not anyone asked. */
const DECIDED =
  /\b(?:decid(?:ed|e|ion)|agreed|we (?:will|won['’]t|are going to)|from now on|always|never|prefer(?:s|red)?|policy|the rule is|must|going forward|settled on)\b/iu;

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
  const copied = input.recentTurns.find((m) => FRAMING.test(m) && sameWords(text, m));
  if (copied) {
    const fact = copied.replace(FRAMING, '').trim();
    return {
      code: 'restates_message',
      rule: 'the note is the message copied back; keep the fact, not the request to remember it.',
      howToWrite: fact.length >= NOTE_TEXT_MIN ? fact : 'The value they gave, as one sentence.',
    };
  }
  const asked =
    ASKED.test(newest) ||
    CORRECTION.test(newest) ||
    input.recentTurns.some((m) => STANDING.test(m) || (ASKED.test(m) && covers(m, text)));
  if (!asked && !DECIDED.test(text) && !DECIDED.test(newest))
    return {
      code: 'unasked',
      rule: 'nobody asked to keep this and it is not a decision; the conversation holds it.',
      howToWrite:
        'Nothing, unless they ask you to remember it or it settles how the project works.',
    };
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

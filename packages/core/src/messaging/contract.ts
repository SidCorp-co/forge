/**
 * What a message to a person is, and what judging one produces.
 *
 * An audience says who reads it; an intent says what it asks of them. The pair
 * names a cell, the cell holds the rules, and a door holds the rest — how many
 * times a message may be repaired and what happens when it cannot be. Nothing
 * here knows a transport, and nothing here can hand a caller a rewritten message
 * (ISS-997).
 */

import type { MessageFacts } from './facts.js';

/** Who reads it. Two are shipped; `registerAudience` is how a third arrives. */
export type Audience = string;

/** What it asks of them. `ask` — the reader owes an answer. `report` — nothing. */
/**
 * What the message asks of its reader. `ask` wants an answer back; `report`
 * and `chat` do not. `chat` is a report the reader is WAITING on, in a room
 * they opened — and it is separate from `report` because the turn behind it
 * ends: figures have a snapshot to be checked against, and a promise of a
 * later action has nothing that will keep it.
 */
export type Intent = 'ask' | 'report' | 'chat';

export type CellId = `${string}:${Intent}`;

export const cellId = (audience: Audience, intent: Intent): CellId => `${audience}:${intent}`;

/** One way a message broke one rule, with the offending fragment quoted back. */
export interface RuleBreak {
  readonly quote: string | null;
  /** Why it broke, phrased as the message's own problem. */
  readonly why: string;
}

/** What a rule needs gathered before it can judge anything. */
export type FactKind = 'issue-rows' | 'progress' | 'prefixes';

export interface MessageRule {
  readonly id: string;
  /** What a message obeying this rule looks like. */
  readonly shape: string;
  /** A message that obeys it. Asserted against every rule in its own cell. */
  readonly example: string;
  readonly needs: readonly FactKind[];
  /**
   * Where this rule breaking makes every later rule in the cell meaningless for
   * that segment — an empty segment has nothing for the rest of them to read.
   */
  readonly halts?: boolean;
  check(text: string, facts: MessageFacts): readonly RuleBreak[];
}

/**
 * A rule broken, told to whoever wrote it: which rule, what went wrong, the
 * shape it should have had, and one message that has it.
 */
export interface MessageRefusal {
  readonly rule: string;
  readonly why: string;
  readonly quote: string | null;
  readonly shape: string;
  readonly example: string;
}

/**
 * The whole result of screening. There is NO text on it, in either arm.
 */
export type MessageVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusals: readonly MessageRefusal[] };

/** A cell: the pair, and the rules that pair is read against. */
export interface CellSpec {
  readonly id: CellId;
  readonly audience: Audience;
  readonly intent: Intent;
  readonly rules: readonly MessageRule[];
  /** True where the product has no door that declares this pair yet. */
  readonly reserved: boolean;
}

/**
 * A door: where a message is screened, and what happens when it cannot pass.
 */
export type DoorPolicy =
  | {
      readonly id: DoorId;
      readonly cell: CellId;
      /** Nothing is posted; telling the writer IS the whole answer. */
      readonly ending: 'refusal';
      readonly why: string;
    }
  | {
      readonly id: DoorId;
      readonly cell: CellId;
      /** Somebody is waiting on a reply, so something is posted either way. */
      readonly ending: 'fallback';
      readonly repairs: 0 | 1 | 2;
      readonly why: string;
    };

export type DoorId =
  | 'comment-write'
  | 'question-ask'
  | 'question-delivery'
  | 'chat-sync'
  | 'web-chat-reply'
  | 'escalation-synthesis'
  | 'agent-chat-completion';

/** The refusal a caller gets when it reaches a write door with a message that cannot pass. */
export class MessageRefusedError extends Error {
  readonly code = 'MESSAGE_REFUSED' as const;
  constructor(
    readonly door: DoorId,
    readonly refusals: readonly MessageRefusal[],
  ) {
    super(renderRefusals(refusals));
    this.name = 'MessageRefusedError';
  }
}

/** The one way a refusal becomes prose, so every door says it the same way. */
export function renderRefusals(refusals: readonly MessageRefusal[]): string {
  return refusals
    .map((r) => `${r.why}\n  rule: ${r.rule}\n  shape: ${r.shape}\n  for example: ${r.example}`)
    .join('\n');
}

/** The legacy `problems` projection, for callers that still speak that shape. */
export function problemsOf(verdict: MessageVerdict): string[] {
  return verdict.ok ? [] : verdict.refusals.map((r) => r.why);
}

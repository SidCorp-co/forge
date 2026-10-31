import type { DoorId, MessageRefusalCode } from '@forge/contracts/messaging';
import { RefusalError } from '../lib/refusal.js';
import type { MessageFacts } from './facts.js';

export type Audience = string;

export type Intent = 'ask' | 'report' | 'chat';

export type CellId = `${string}:${Intent}`;

export const cellId = (audience: Audience, intent: Intent): CellId => `${audience}:${intent}`;

export interface RuleBreak {
  readonly quote: string | null;
  /** Why it broke, phrased as the message's own problem. */
  readonly why: string;
  /**
   * Set where the rule could not run, as why, in the words the person is told: the message is held
   * for want of the check, not for a claim the check found false, and a reply that ends held says so.
   */
  readonly unchecked?: string;
}

/** What a rule needs gathered before it can judge anything. */
export type FactKind = 'issue-rows' | 'progress' | 'prefixes' | 'report-runs' | 'agreed-records';

export interface MessageRule {
  readonly id: string;
  /** What a message obeying this rule looks like. */
  readonly shape: string;
  /** A message that obeys it. Asserted against every rule in its own cell. */
  readonly example: string;
  readonly needs: readonly FactKind[];
  readonly halts?: boolean;
  check(text: string, facts: MessageFacts): readonly RuleBreak[];
}

export interface MessageRefusal {
  readonly rule: string;
  readonly why: string;
  readonly quote: string | null;
  readonly shape: string;
  readonly example: string;
  /** The rule could not run, and why (`RuleBreak.unchecked`). */
  readonly unchecked?: string;
}

declare const judgedByTheScreen: unique symbol;

/**
 * The whole result of screening. There is NO text on it, in either arm.
 */
export type MessageVerdict =
  | { readonly ok: true; readonly [judgedByTheScreen]: true }
  | { readonly ok: false; readonly refusals: readonly MessageRefusal[] };

/** A cell: the pair, and the rules that pair is read against. */
export interface CellSpec {
  readonly id: CellId;
  readonly audience: Audience;
  readonly intent: Intent;
  readonly rules: readonly MessageRule[];
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

export type { DoorId };

/**
 * The refusal a caller gets when it reaches a write door with a message that cannot pass: one row per
 * broken rule at `at`, the JSON pointer of the screened text in the caller's request. Both doors
 * answer it in the envelope (`MESSAGE_REFUSED`, 422), so every route refuses it by name.
 */
export function messageRefused(
  door: DoorId,
  refusals: readonly MessageRefusal[],
  at = '/body',
): RefusalError {
  const code: MessageRefusalCode = 'MESSAGE_REFUSED';
  const rows = refusals.map((r) => ({
    code,
    path: at,
    detail: `${r.why} (rule ${r.rule}; shape: ${r.shape}; for example: ${r.example}; door ${door})`,
  }));
  return new RefusalError(
    rows.length > 0 ? rows : [{ code, path: at, detail: `refused at door ${door}` }],
    code,
  );
}

/** The one way a refusal becomes prose, so every door says it the same way. */
export function renderRefusals(refusals: readonly MessageRefusal[]): string {
  return refusals
    .map((r) => `${r.why}\n  rule: ${r.rule}\n  shape: ${r.shape}\n  for example: ${r.example}`)
    .join('\n');
}

/** What a verdict refused; none for a verdict that passed. */
export function refusalsOf(verdict: MessageVerdict): readonly MessageRefusal[] {
  return verdict.ok ? [] : verdict.refusals;
}

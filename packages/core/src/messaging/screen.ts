/**
 * The one screen. An audience and an intent name a cell, the cell's rules read
 * the message, and what comes back is a verdict — never a message.
 */

import { audienceSpec } from './audiences.js';
import { cellFor } from './cells.js';
import type {
  Audience,
  DoorId,
  Intent,
  MessageRefusal,
  MessageRule,
  MessageVerdict,
} from './contract.js';
import { doorCell } from './doors.js';
import { type MessageFacts, NO_FACTS } from './facts.js';

export interface ScreenInput {
  readonly audience: Audience;
  readonly intent: Intent;
  /**
   * The message. More than one where the message renders as parts a reader
   * chooses between — a question's prompt and its option labels.
   */
  readonly segments: readonly string[];
  readonly facts?: MessageFacts;
}

/**
 * What each passing verdict was passed OVER, kept where only this module can write it.
 */
const JUDGED = new WeakMap<object, readonly string[]>();

/**
 * Admit these exact segments. The one mint, and it registers what it admitted.
 */
export function admitted(segments: readonly string[]): MessageVerdict {
  const verdict = { ok: true } as MessageVerdict;
  JUDGED.set(verdict as object, [...segments]);
  return verdict;
}

/** What this verdict was passed over, or null where nothing registered it. */
export function judgedSegments(verdict: MessageVerdict): readonly string[] | null {
  return verdict.ok ? (JUDGED.get(verdict as object) ?? null) : null;
}

function refusalsFor(rule: MessageRule, text: string, facts: MessageFacts): MessageRefusal[] {
  return rule.check(text, facts).map((b) => ({
    rule: rule.id,
    why: b.why,
    quote: b.quote,
    shape: rule.shape,
    example: rule.example,
  }));
}

/**
 * A pair no cell covers is REFUSED, never admitted.
 */
function noCell(audience: Audience, intent: Intent): MessageVerdict {
  const known = audienceSpec(audience)
    ? `no rules are declared for intent "${intent}" on audience "${audience}"`
    : `"${audience}" is not an audience this server knows`;
  return {
    ok: false,
    refusals: [
      {
        rule: 'cell-exists',
        why: `a message cannot be screened: ${known}`,
        quote: null,
        shape: 'every message names an audience and an intent that together name a cell',
        example: 'audience "role", intent "report"',
      },
    ],
  };
}

export function screenMessage(input: ScreenInput): MessageVerdict {
  const { audience, intent } = input;
  if (!audience || !intent) return noCell(audience, intent);
  const cell = cellFor(audience, intent);
  if (!cell) return noCell(audience, intent);

  const facts = input.facts ?? NO_FACTS;
  const refusals: MessageRefusal[] = [];
  for (const segment of input.segments) {
    for (const rule of cell.rules) {
      const broke = refusalsFor(rule, segment ?? '', facts);
      if (broke.length === 0) continue;
      refusals.push(...broke);
      if (rule.halts) break;
    }
  }
  return refusals.length === 0 ? admitted(input.segments) : { ok: false, refusals };
}

/** The same screen, named by the door that is running it. */
export function screenAtDoor(
  door: DoorId,
  segments: readonly string[],
  facts?: MessageFacts,
): MessageVerdict {
  const { audience, intent } = doorCell(door);
  return screenMessage(
    facts ? { audience, intent, segments, facts } : { audience, intent, segments },
  );
}

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
// cm:guard a nominal `ok` flag says a screen ran; it does not say WHAT it read, so a genuine verdict
// for one string could still mint a proof for another — `proven(door, wholeAgentText(B), verdictForA)`
// compiled and posted B. This map is what makes a verdict a statement about its own input: it is
// module-private and written once, at the moment the verdict is created, so nothing can re-point an
// existing verdict at different text (ISS-978 F5, whole-set review F2).
// cm:guard it lives HERE and not on the verdict, because `contract.ts` forbids a text field on either
// arm — a layer that could read the message back off a verdict could hand an edited one on. Nothing
// outside this module can read this map either; `judgedSegments` answers the one question `proven`
// asks, which is whether a given list is the list that was judged.
const JUDGED = new WeakMap<object, readonly string[]>();

/**
 * Admit these exact segments. The one mint, and it registers what it admitted.
 */
// cm:guard exported for the files that ARE screens but do not run a cell — `comment-carry.ts` reads a
// carried comment against one rule and refuses on what it finds. `verdict-mint.test.ts` holds the
// whole list of files allowed to call it, which is what stops the sixth reply path declaring its own
// text passed the way five of them used to (ISS-978 F5).
// cm:guard a FRESH object every call, never a shared constant: the map is keyed on the verdict, so two
// screens sharing one `ok` value would each overwrite the other's record of what it read.
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
// cm:guard the unknown-pair arm is the load-bearing one: admitting a message whose audience nobody declared is how a new surface ships unscreened and looks screened, which is the state ISS-997 found the comment door in. A caller that cannot name its pair has to fail here rather than pass.
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
      // cm:why a halting rule stops the rest for THIS segment only: an empty segment has nothing for the later rules to read, and running them anyway produced a second problem about the same silence (the old operator screen `continue`d for the same reason).
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

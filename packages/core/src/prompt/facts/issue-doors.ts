// The doors an issue moves and lands through, as the rules a step and a drive run are handed teach
// them (ISS-1251): rendered from those doors' capability cards, so the rules hold no second copy of
// how to park, stamp a merge or wait on a blocker. A card's situation, practice and red flag are
// the one text; the rest of the card is read with `guides/doors.md?door=<door>`.

import { type CapabilityCard, situationsFor } from '@forge/contracts/capability-cards';
import { AFFORDANCE_CARDS } from './affordance-cards.js';

/** The doors the rules turn on: the status move, the merge mark and the blocker edge. */
export const ISSUE_DOORS = [
  'POST /api/issues/:id/transition',
  'POST /api/issues/:id/merge',
  'POST /api/issues/:id/dependencies',
] as const;

/** The cards of the issue's doors, each refused by name where no card holds it. */
export function issueDoorCards(): CapabilityCard[] {
  return ISSUE_DOORS.map((id) => {
    const card = AFFORDANCE_CARDS.find((c) => c.id === id);
    if (!card) {
      throw new Error(
        `prompt: the rules render ${id} from its card, and prompt/facts/affordance-cards.ts holds none`,
      );
    }
    return card;
  });
}

const sentence = (s: string) => s.replace(/[.;]$/, '');
/** A table row's situation ("An issue that …") read after "When". */
const after = (s: string) => (/^[A-Z][a-z]/.test(s) ? `${s[0]?.toLowerCase()}${s.slice(1)}` : s);

/**
 * The block: per door, the situations a run meets and the card's practice and red flag; what to watch
 * for in a situation is the refusal's own, named when it is met, and the card's page. Where the
 * rules already carry the orientation's table (`besideTable`), a situation the table shows (any a
 * master meets) is left to it, so no situation is said twice in one prompt.
 */
export function issueDoorsText(opts: { besideTable: boolean }): string {
  const blocks = issueDoorCards().map((card) => {
    const own = situationsFor(card, 'run').filter(
      (s) => !opts.besideTable || (s.for !== undefined && !s.for.includes('master')),
    );
    return [
      `- \`${card.id}\`: ${card.purpose}`,
      ...own.map(
        (s) =>
          `  - When ${after(sentence(s.when))}: ${sentence(s.do)}.`,
      ),
      ...card.practice.map((p) => `  - ${p}`),
      ...(card.redFlag ? [`  - Red flag: ${card.redFlag}`] : []),
    ].join('\n');
  });
  return `## Moving and landing the issue
From the cards of the doors an issue moves through; what to watch for in each is the rest of its card, \`guides/doors.md?door=<the door>\`.
${blocks.join('\n')}`;
}

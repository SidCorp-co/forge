// Budgets trigger consolidation, never a cut (ISS-1251 §5): once a pass, the steward reads each text
// every prompt of the project carries against its cap, and opens one consolidation item for each pile
// past it. What the project owns (its always-on knowledge, its lessons map) is one `simplify` debt on
// its ledger for the cleanup run; what Forge ships (a Tier-0 map of cards, a skill's always-on part) is
// Forge's feedback, a repeat from any project one occurrence. No pile is truncated here: the reads that
// carry them keep counting what they cannot carry.

import type { PileRow } from '@forge/contracts/door-use';
import { LESSON_FOLD_AFTER_APPLIED } from '@forge/contracts/lessons';
import { cutAtWord } from '@forge/contracts/title-text';
import { recordForgeDebt } from '../cleanup/index.js';
import { fileForgeFeedback } from '../feedback/index.js';
import { logger } from '../lib/logger.js';
import { findProjectSlugs } from '../projects/index.js';
import { stewardPorts } from './ports.js';

const TITLE_CHARS = 120;

const over = (p: PileRow) =>
  `${p.name} is ${p.size} of ${p.cap} characters and carries ${p.carried} of ${p.items}`;

const PROJECT_DETAIL: Record<'always_knowledge' | 'lessons_map', string> = {
  always_knowledge:
    'Fold each entry that repeats a card, guide or rule into the one that owns it, merge entries that say one thing, and move to on_demand what not every prompt needs; never cut an entry to fit.',
  lessons_map: `A lesson that held ${LESSON_FOLD_AFTER_APPLIED} uses folds into its card as a proposed delta: carry the proposed deltas into the card's code. Two lessons that say one thing are reported as a conflict confusion (POST /api/projects/:id/lessons/<n>/confusions), which the steward settles; never cut the map.`,
};

const FORGE_DETAIL: Record<'tier0_map' | 'skill_always_on', string> = {
  tier0_map:
    'Merge the cards of this audience that teach one situation, or move a rarely used one to its tool description; never cut a card to fit the map.',
  skill_always_on:
    "Move what only some steps need from the skill's always-on description into the skill's body or a guide it names; never cut the description to fit.",
};

/** One consolidation item per pile past its cap; how many were opened (a standing item is not reopened). */
export async function openPileConsolidations(
  projectId: string,
  stewardId: string,
): Promise<number> {
  const { piles } = await stewardPorts().piles(projectId);
  let opened = 0;
  for (const p of piles.filter((x) => x.over)) {
    const read = `GET /api/projects/${projectId}/metrics/piles`;
    if (p.pile === 'always_knowledge' || p.pile === 'lessons_map') {
      const wrote = await recordForgeDebt({
        projectId,
        item: {
          kind: 'simplify',
          check: `pile:${p.pile}`,
          where: p.name,
          detail: `${over(p)}. ${PROJECT_DETAIL[p.pile]} Read the pile at ${read}.`,
          impact: {
            type: 'logic',
            rating: 'low',
            reason:
              'Recorded by the steward from the pile read: every prompt carries this text, and past its cap the lines it cannot carry reach no agent.',
          },
        },
      });
      if (wrote) opened += 1;
      continue;
    }
    const slug = (await findProjectSlugs([projectId])).get(projectId) ?? projectId;
    const filed = await fileForgeFeedback({
      actor: { userId: stewardId, agency: 'agent' },
      request: {
        kind: 'change_request',
        title: cutAtWord(`Consolidate ${p.name}: past its cap`, TITLE_CHARS),
        whereSeen: p.pile === 'tier0_map' ? `the Tier-0 ${p.name}` : `skill ${p.name}`,
        body: [`In ${slug}, ${over(p)}.`, FORGE_DETAIL[p.pile], `Read it at ${read}.`].join('\n\n'),
        signalKey: `pile/${p.pile}/${p.name}`,
      },
      source: { projectId, issueId: null, runId: null, clientVersion: null },
    });
    if (!filed.ok) {
      logger.warn(
        { projectId, pile: p.name, refusals: filed.refusals.map((r) => r.code) },
        'steward: a pile past its cap was not routed to Forge; it is tried again next pass',
      );
      continue;
    }
    if (filed.created) opened += 1;
  }
  return opened;
}

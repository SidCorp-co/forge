// Budgets trigger consolidation, never a cut (ISS-1251 §5): once a pass, the steward reads each text
// every prompt of the project carries against its cap, and opens one consolidation item for each pile
// past it. What the project owns (its always-on knowledge, its lessons map) is one `simplify` debt on
// its ledger for the cleanup run; a skill's always-on part is Forge's feedback, a repeat from any
// project one occurrence. A Tier-0 map is reported and raises nothing: it carries the most used cards
// within its cap and reaches the rest through forge_find, which is its design, not an overflow. No
// pile is truncated here: the reads that carry it serve it whole and name what runs past the cap.
// The item carries the merges the steward proposes over the pile's own entries (ISS-1251 c5), which
// the cleanup run applies: the steward reads and proposes, an agent writes.

import type { PileRow } from '@forge/contracts/door-use';
import { LESSON_FOLD_AFTER_APPLIED } from '@forge/contracts/lessons';
import { cutAtWord } from '@forge/contracts/title-text';
import { z } from 'zod';
import { recordForgeDebt } from '../cleanup/index.js';
import { fileForgeFeedback } from '../feedback/index.js';
import { callFastModelObject } from '../integrations/llm/index.js';
import { logger } from '../lib/logger.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import { findProjectSlugs } from '../projects/index.js';
import { noteJudgeMiss } from './lessons-pass-report.js';
import { type PileEntry, stewardPorts } from './ports.js';

const TITLE_CHARS = 120;

const over = (p: PileRow) =>
  `${p.name} is ${p.size} of ${p.cap} characters and carries ${p.carried} of ${p.items}`;

const PROJECT_DETAIL: Record<'always_knowledge' | 'lessons_map', string> = {
  always_knowledge:
    'Fold each entry that repeats a card, guide or rule into the one that owns it, merge entries that say one thing, and move to on_demand what not every prompt needs; never cut an entry to fit.',
  lessons_map: `A lesson that held ${LESSON_FOLD_AFTER_APPLIED} uses folds into its card as a proposed delta: carry the proposed deltas into the card's code. Two lessons that say one thing are reported as a conflict confusion (POST /api/projects/:id/lessons/<n>/confusions), which the steward settles; never cut the map.`,
};

/** The most merges one item proposes, and the characters each merged entry's gist takes. */
const MERGES_MAX = 4;
const SAYS_MAX = 240;

const mergeSchema = z.object({
  merges: z
    .array(
      z.object({
        from: z.array(z.string()).min(2),
        into: z.string(),
        says: z.string().min(1).max(SAYS_MAX),
      }),
    )
    .max(MERGES_MAX),
});

/** One merge the steward proposes: the entries that say one thing, the one they fold into, its gist. */
export type PileMerge = z.infer<typeof mergeSchema>['merges'][number];

/** The steward's merges over a pile past its cap; null where it gave none it could stand behind. */
export type Merger = (
  projectId: string,
  pile: PileRow,
  entries: readonly PileEntry[],
) => Promise<PileMerge[] | null>;

export function mergePrompt(pile: PileRow, entries: readonly PileEntry[]): string {
  return [
    `Every prompt of this project carries its ${pile.name}: ${pile.size} of ${pile.cap} characters, served whole past the cap.`,
    `Propose at most ${MERGES_MAX} merges that bring it back under: entries that say one thing, or one entry repeating another, folded into the one that keeps it. Name each by its key; \`into\` is one of \`from\`; \`says\` is what the merged entry says, in at most ${SAYS_MAX} characters. Propose none where no two entries say one thing.`,
    `The entries:\n${markUntrusted(entries.map((e) => `- ${e.key}: ${e.text.slice(0, 600)}`).join('\n'), { source: `the ${pile.name}` })}`,
  ].join('\n\n');
}

export const modelMerger: Merger = async (projectId, pile, entries) => {
  const answer = await callFastModelObject(
    { surface: 'lessons', projectId, what: `merges proposed for the ${pile.pile} pile` },
    mergePrompt(pile, entries),
    mergeSchema,
    { maxTokens: 1500 },
  );
  if (answer.ok) return answer.value.merges;
  noteJudgeMiss(answer.miss, answer.detail);
  return null;
};

/** The merges that name entries the pile holds, each folding into one of its own. */
const standing = (merges: readonly PileMerge[], entries: readonly PileEntry[]) => {
  const keys = new Set(entries.map((e) => e.key));
  return merges.filter(
    (m) => m.from.includes(m.into) && new Set(m.from).size >= 2 && m.from.every((k) => keys.has(k)),
  );
};

/** How the cleanup run applies one merge, where the pile is the project's. */
const APPLY: Record<'always_knowledge' | 'lessons_map', string> = {
  always_knowledge:
    'Apply each with PUT /api/projects/:id/knowledge/<into> carrying the merged text, then archive the others it names.',
  lessons_map:
    'Apply each with a conflict confusion on the first lesson naming the others (POST /api/projects/:id/lessons/<n>/confusions, recommended edit with the merged sentence); the steward settles it.',
};

const proposed = (pile: 'always_knowledge' | 'lessons_map', merges: readonly PileMerge[]) =>
  merges.length === 0
    ? ''
    : ` Merges proposed: ${merges
        .map((m, i) => `(${i + 1}) ${m.from.join(' + ')} into ${m.into}: "${m.says}"`)
        .join('; ')}. ${APPLY[pile]}`;

const SKILL_DETAIL =
  "Move what only some steps need from the skill's always-on description into the skill's body or a guide it names; never cut the description to fit.";

/** One consolidation item per pile past its cap; how many were opened (a standing item is not reopened). */
export async function openPileConsolidations(
  projectId: string,
  stewardId: string,
  merge: Merger = modelMerger,
): Promise<number> {
  const { piles } = await stewardPorts().piles(projectId);
  let opened = 0;
  // a Tier-0 map past its cap is its Tier-1 disclosure at work (forge_find), never an item
  for (const p of piles.filter((x) => x.over && x.pile !== 'tier0_map')) {
    const read = `GET /api/projects/${projectId}/metrics/piles`;
    if (p.pile === 'always_knowledge' || p.pile === 'lessons_map') {
      const entries = await stewardPorts().pileEntries(projectId, p.pile);
      const merges = standing((await merge(projectId, p, entries)) ?? [], entries);
      const past = p.past.length > 0 ? ` Served past the cap: ${p.past.join(', ')}.` : '';
      const wrote = await recordForgeDebt({
        projectId,
        item: {
          kind: 'simplify',
          check: `pile:${p.pile}`,
          where: p.name,
          detail: `${over(p)}.${past}${proposed(p.pile, merges)} ${PROJECT_DETAIL[p.pile]} Read the pile at ${read}.`,
          impact: {
            type: 'logic',
            rating: 'low',
            reason:
              'Recorded by the steward from the pile read: every prompt carries this text whole, and past its cap it costs every prompt what the merge would save.',
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
        whereSeen: `skill ${p.name}`,
        body: [`In ${slug}, ${over(p)}.`, SKILL_DETAIL, `Read it at ${read}.`].join('\n\n'),
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

import type { ProjectDocument } from './schema.js';

export type Promotion = ProjectDocument['promotions'][number];

/**
 * How many promotions a landed change may cross to reach the branch production deploys from.
 * The release agent reads the procedure and performs one crossing; a longer chain is declarable
 * but nothing performs the middle of it, so a document declaring one is refused at write
 * (`rules.ts`, PROMOTION_CHAIN_UNSUPPORTED) rather than left to be skipped at the first release.
 */
export const MAX_PERFORMED_CROSSINGS = 1;

export function crossingsTo(
  promotions: readonly Promotion[],
  from: string,
  to: string,
): Promotion[] | null {
  const queue: { at: string; trail: Promotion[] }[] = [{ at: from, trail: [] }];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const { at, trail } = queue.shift() as { at: string; trail: Promotion[] };
    if (at === to) return trail;
    for (const p of promotions.filter((q) => q.from === at && !seen.has(q.to))) {
      seen.add(p.to);
      queue.push({ at: p.to, trail: [...trail, p] });
    }
  }
  return null;
}

/** The crossings from where work lands to where production deploys from; null where either is undeclared or unreached. */
export function releaseCrossingsOf(document: ProjectDocument): Promotion[] | null {
  const defaultBranch = document.source.type === 'git' ? document.source.git.defaultBranch : null;
  const production = Object.values(document.environments).find((e) => e.tier === 'production');
  if (defaultBranch === null || production?.deploysFrom === undefined) return null;
  return crossingsTo(document.promotions, defaultBranch, production.deploysFrom);
}

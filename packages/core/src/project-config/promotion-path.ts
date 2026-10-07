import type { EnvironmentDeclaration, ProjectDocument } from './schema.js';

export type Promotion = ProjectDocument['promotions'][number];

/**
 * How many promotions a landed change may cross to reach the branch production deploys from.
 * The release agent reads the procedure and performs one crossing; a longer chain is declarable
 * but nothing performs the middle of it, so a document declaring one is refused at write
 * (`rules.ts`, PROMOTION_CHAIN_UNSUPPORTED) rather than left to be skipped at the first release.
 */
export const MAX_PERFORMED_CROSSINGS = 1;

function crossingsTo(
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

export interface NamedEnvironment {
  name: string;
  declaration: EnvironmentDeclaration;
}

export function environmentsOf(document: ProjectDocument): NamedEnvironment[] {
  return Object.entries(document.environments).map(([name, declaration]) => ({
    name,
    declaration,
  }));
}

export function productionOf(document: ProjectDocument): NamedEnvironment | null {
  return environmentsOf(document).find((e) => e.declaration.tier === 'production') ?? null;
}

export function defaultBranchOf(document: ProjectDocument | null | undefined): string | null {
  return document?.source.type === 'git' ? document.source.git.defaultBranch : null;
}

/** Where work lands and where production deploys from, and the promotions between them. */
export interface ReleaseLanding {
  /** `source.git.defaultBranch`, where work lands; null on a project with no git source. */
  defaultBranch: string | null;
  production: NamedEnvironment | null;
  /** The branch production deploys from; undefined where it declares none. */
  target: string | undefined;
  /** The promotions from the landing branch to `target`: empty where either end is undeclared, null where `target` is unreached. */
  crossings: Promotion[] | null;
}

export function releaseLandingOf(document: ProjectDocument): ReleaseLanding {
  const defaultBranch = defaultBranchOf(document);
  const production = productionOf(document);
  const target = production?.declaration.deploysFrom;
  const crossings =
    defaultBranch === null || target === undefined
      ? []
      : crossingsTo(document.promotions, defaultBranch, target);
  return { defaultBranch, production, target, crossings };
}

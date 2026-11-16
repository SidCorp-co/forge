// The find door's ranking and shape (ISS-1256), pure: every arm's ranked list fused by reciprocal
// rank through `lib/search-fusion.ts`, then filtered, faceted and grouped by type. A person's Cmd-K
// and an agent's find read this one order.

import {
  FIND_TYPE_LABELS,
  FIND_TYPES,
  FIND_UNPLACED,
  FIND_UNPLACED_FILTER,
  type FindFacet,
  type FindHit,
  type FindHitModule,
  type FindMatchArm,
  type FindResult,
  type FindType,
} from '@forge/contracts/find';
import { fuseRanked, HYBRID_WEIGHTS } from '../lib/search-fusion.js';
import type { ArmList, Candidate } from './candidate.js';

/**
 * What a rank in each arm is worth. An alias names the term outright, so its one hit outweighs a
 * keyword and a dense rank together; keyword and dense take the hybrid split every search shares.
 */
export const ARM_WEIGHTS: Record<FindMatchArm, number> = {
  alias: 1,
  keyword: HYBRID_WEIGHTS.keyword,
  semantic: HYBRID_WEIGHTS.semantic,
};

/** A candidate after the fusion: its fused score, every arm that found it, the alias that matched. */
export type Fused = Candidate & { arms: FindMatchArm[]; matchedAlias: string | null };

/** Every list fused into one order, best first, each hit once. */
export function fuseArms(lists: readonly ArmList[]): Fused[] {
  const arms = new Map<string, Set<FindMatchArm>>();
  const aliases = new Map<string, string>();
  for (const list of lists) {
    for (const hit of list.hits) {
      const held = arms.get(hit.id) ?? new Set();
      held.add(list.arm);
      arms.set(hit.id, held);
      if (hit.alias && !aliases.has(hit.id)) aliases.set(hit.id, hit.alias);
    }
  }
  const total = lists.reduce((n, l) => n + l.hits.length, 0);
  return fuseRanked(
    lists.map((l) => ({ hits: l.hits, weight: ARM_WEIGHTS[l.arm] })),
    Math.max(total, 1),
  ).map((c) => ({
    ...c,
    arms: [...(arms.get(c.id) ?? [])].sort(),
    matchedAlias: aliases.get(c.id) ?? null,
  }));
}

/** What the shape reads beside the fused list: modules, placements and where a hit opens. */
export interface ShapeContext {
  modules: ReadonlyMap<string, FindHitModule>;
  /** The module label each candidate is placed in, by candidate id. */
  placements: ReadonlyMap<string, string>;
  projectSlugs: ReadonlyMap<string, string>;
  /** The REST path a hit opens at, given its id. */
  openPath: (id: string) => string;
}

export interface ShapeFilters {
  type?: readonly FindType[] | undefined;
  module?: readonly string[] | undefined;
  status?: readonly string[] | undefined;
  limit: number;
}

const EXCERPT = 280;

const excerptOf = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat;
};

/** One fused candidate as the door answers it. */
export function hitOf(c: Fused, ctx: ShapeContext): FindHit {
  const label = ctx.placements.get(c.id);
  const module = label ? (ctx.modules.get(label) ?? null) : null;
  return {
    id: c.id,
    type: c.type,
    ref: c.ref,
    key: c.key,
    title: c.title,
    excerpt: excerptOf(c.text),
    projectSlug: c.projectId ? (ctx.projectSlugs.get(c.projectId) ?? null) : null,
    module,
    status: c.status,
    path: [module?.name ?? FIND_UNPLACED, FIND_TYPE_LABELS[c.type]],
    match: { arms: c.arms, alias: c.matchedAlias },
    score: c.score,
    open: ctx.openPath(c.id),
  };
}

function facet(
  hits: readonly FindHit[],
  of: (h: FindHit) => { value: string; label: string } | null,
) {
  const counts = new Map<string, FindFacet>();
  for (const h of hits) {
    const v = of(h);
    if (!v) continue;
    const held = counts.get(v.value) ?? { ...v, count: 0 };
    held.count += 1;
    counts.set(v.value, held);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

const moduleValue = (h: FindHit) => h.module?.slug ?? FIND_UNPLACED_FILTER;

/** The fused hits filtered, faceted over all of them, cut to `limit`, and grouped by type. */
export function shapeResult(
  fused: readonly Fused[],
  filters: ShapeFilters,
  ctx: ShapeContext,
): Pick<FindResult, 'groups' | 'facets' | 'total'> {
  const all = fused.map((c) => hitOf(c, ctx));
  const facets = {
    type: facet(all, (h) => ({ value: h.type, label: FIND_TYPE_LABELS[h.type] })),
    module: facet(all, (h) => ({ value: moduleValue(h), label: h.module?.name ?? FIND_UNPLACED })),
    status: facet(all, (h) => (h.status ? { value: h.status, label: h.status } : null)),
  };
  const kept = all
    .filter((h) => !filters.type?.length || filters.type.includes(h.type))
    .filter((h) => !filters.module?.length || filters.module.includes(moduleValue(h)))
    .filter(
      (h) => !filters.status?.length || (h.status !== null && filters.status.includes(h.status)),
    )
    .slice(0, filters.limit);
  // a group stands where its best hit ranks, so the first hit of the first group is the best of all
  const firstAt = (type: FindType) => kept.findIndex((h) => h.type === type);
  const groups = FIND_TYPES.filter((type) => firstAt(type) >= 0)
    .sort((a, b) => firstAt(a) - firstAt(b))
    .map((type) => ({
      type,
      label: FIND_TYPE_LABELS[type],
      hits: kept.filter((h) => h.type === type),
    }));
  return { groups, facets, total: kept.length };
}

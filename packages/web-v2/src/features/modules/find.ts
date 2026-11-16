// The find door's adapter (ISS-1256): the one search people reach by ⌘K and agents by `forge_find`,
// read from core's `GET /projects/:id/find`. Every reading of a find the palette makes is here: the
// query it sends, the facets it toggles, and where opening a hit walks, so a change to the contract
// changes this file alone.

import { FIND_UNPLACED_FILTER, type FindGapsView, type FindHit, type FindOpened, type FindResult } from "@forge/contracts/find";
import { MODULE_MAP_BRANCHES, type ModuleMapBranch } from "@forge/contracts/module-map";
import { apiClient } from "@/lib/api/client";
import { nodeIdOf } from "./module-tree";
import { treeHref } from "./pillar";

export const FIND_FACETS = ["type", "module", "status"] as const;
export type FindFacetName = (typeof FIND_FACETS)[number];
export type FindFilters = Record<FindFacetName, string[]>;

export const NO_FILTERS: FindFilters = { type: [], module: [], status: [] };

/** The query string a find is sent with: the words, then each facet the person turned on. */
export function findParams(q: string, filters: FindFilters): string {
  const p = new URLSearchParams({ q: q.trim() });
  for (const f of FIND_FACETS) if (filters[f].length > 0) p.set(f, filters[f].join(","));
  return p.toString();
}

export function toggleFilter(filters: FindFilters, facet: FindFacetName, value: string): FindFilters {
  const on = filters[facet];
  return { ...filters, [facet]: on.includes(value) ? on.filter((v) => v !== value) : [...on, value] };
}

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export const findApi = {
  find: (projectId: string, q: string, filters: FindFilters) => apiClient<FindResult>(`${projectPath(projectId)}/find?${findParams(q, filters)}`),
  /** Opening a hit is the read signal: core records it and answers where the record is read. */
  open: (hit: FindHit) => apiClient<FindOpened>(hit.open.replace(/^\/api(?=\/)/, "")),
  /** The searches that found nothing over the window: what the map still lacks a name for. */
  gaps: (projectId: string) => apiClient<FindGapsView>(`${projectPath(projectId)}/find/gaps`),
};

const isMapBranch = (t: string): t is ModuleMapBranch => (MODULE_MAP_BRANCHES as readonly string[]).includes(t);

/**
 * Where opening a hit walks on the map: a record of a tree branch opens its module's tree with it
 * selected (Unplaced where no module holds it); anything else (an issue, a lesson, a conversation)
 * has no node, so null, and the hit opens where core says it is read. A requirement's node is named
 * by its key (`REQ-3`), as the tree names it, not by its row id.
 */
export function walkHref(slug: string, hit: FindHit): string | null {
  if (!isMapBranch(hit.type)) return null;
  const ref = hit.type === "requirement" ? (hit.key ?? hit.ref) : hit.ref;
  return treeHref(slug, hit.module?.slug ?? FIND_UNPLACED_FILTER, hit.type, nodeIdOf(hit.type, ref));
}

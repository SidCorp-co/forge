// The find door's adapter (ISS-1256): the one search people reach by ⌘K and agents by `forge_find`,
// read from core's `POST /projects/:id/find`. Every reading of a find the palette makes is here: the
// query it sends, the facets it toggles, and where opening a hit walks, so a change to the contract
// changes this file alone.

import { FIND_ORG_REF_PREFIX, FIND_UNPLACED_FILTER, type FindGapsView, type FindHit, type FindOpened, type FindResult, type FindType } from "@forge/contracts/find";
import { MODULE_MAP_BRANCHES, type ModuleMapBranch } from "@forge/contracts/module-map";
import { apiClient } from "@/lib/api/client";
import { LABEL_GROUPS, type LabelGroup } from "@/lib/i18n/labels";
import { nodeIdOf } from "./module-tree";
import { treeHref } from "./pillar";

export const FIND_FACETS = ["type", "module", "status"] as const;
export type FindFacetName = (typeof FIND_FACETS)[number];
export type FindFilters = Record<FindFacetName, string[]>;

export const NO_FILTERS: FindFilters = { type: [], module: [], status: [] };

/** What `POST /projects/:id/find` takes (`findQuerySchema`): the words and the facets turned on. */
export type FindQueryBody = { q: string } & Partial<FindFilters>;

/** The body a find is sent with: the words, then each facet the person turned on. */
export function findBody(q: string, filters: FindFilters): FindQueryBody {
  const body: FindQueryBody = { q: q.trim() };
  for (const f of FIND_FACETS) if (filters[f].length > 0) body[f] = filters[f];
  return body;
}

export function toggleFilter(filters: FindFilters, facet: FindFacetName, value: string): FindFilters {
  const on = filters[facet];
  return { ...filters, [facet]: on.includes(value) ? on.filter((v) => v !== value) : [...on, value] };
}

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export const findApi = {
  find: (projectId: string, q: string, filters: FindFilters) =>
    apiClient<FindResult>(`${projectPath(projectId)}/find`, { method: "POST", body: JSON.stringify(findBody(q, filters)) }),
  /** Opening a hit is the read signal: core records it and answers where the record is read. */
  open: (hit: FindHit) => apiClient<FindOpened>(hit.open.replace(/^\/api(?=\/)/, "")),
  /** The searches that found nothing over the window: what the map still lacks a name for. */
  gaps: (projectId: string) => apiClient<FindGapsView>(`${projectPath(projectId)}/find/gaps`),
};

const isMapBranch = (t: string): t is ModuleMapBranch => (MODULE_MAP_BRANCHES as readonly string[]).includes(t);

/**
 * Where opening a hit walks on the map: a record of a tree branch opens its module's tree with it
 * selected (Unplaced where no module holds it); anything else (an issue, a lesson, a conversation, an
 * org ruling, which no project's tree holds) has no node, so null, and the hit opens where core says
 * it is read. A requirement's node is named
 * by its key (`REQ-3`), as the tree names it, not by its row id.
 */
export function walkHref(slug: string, hit: FindHit): string | null {
  if (!isMapBranch(hit.type) || hit.ref.startsWith(FIND_ORG_REF_PREFIX)) return null;
  const ref = hit.type === "requirement" ? (hit.key ?? hit.ref) : hit.ref;
  return treeHref(slug, hit.module?.slug ?? FIND_UNPLACED_FILTER, hit.type, nodeIdOf(hit.type, ref));
}

/** The types whose key is what a person calls the record (`ISS-12`, `REQ-3`, `FB-7`); any other key is a slug or an id. */
const SAID_KEYS: ReadonlySet<FindType> = new Set(["issue", "requirement", "feedback"]);

/** A hit's line as a person reads it: its key where people say it, then its title. */
export function hitHeading(hit: FindHit): string {
  return hit.key && SAID_KEYS.has(hit.type) && !hit.title.startsWith(hit.key) ? `${hit.key} ${hit.title}` : hit.title;
}

/** The contract vocabulary each type's status is a value of. */
const STATUS_GROUPS: Partial<Record<FindType, LabelGroup>> = { issue: "issueStatus", requirement: "requirementState", feedback: "feedbackPhase" };

/**
 * A status as a person reads it (`in_delivery` → In delivery), never its stored code: read in its
 * type's vocabulary, or on a facet, which counts every type, in the first vocabulary holding it. A
 * work step (`in_progress:test`) reads as its status. A status no vocabulary holds is already words
 * (`in force`, `recheck owed`).
 */
export function findStatusLabel(label: (group: LabelGroup, value: string) => string, value: string, type?: FindType): string {
  const owner = type ? STATUS_GROUPS[type] : undefined;
  const groups = owner ? [owner] : Object.values(STATUS_GROUPS);
  const status = value.split(":")[0] ?? value;
  const group = groups.find((g) => status in LABEL_GROUPS[g]);
  return group ? label(group, status) : value.replace(/_/g, " ");
}

// REQ-33 BC-1: the project's Decisions, Roadmap and Memory pages stood on their own and were removed;
// each record is read on the item it is about. A link kept from before is sent where its record is
// read now, with `?moved=` naming the page it came from so the page it lands on says so.

import { issueHref } from "@/lib/routes/issues";
import { requirementHref, requirementsHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";

export const MOVED_PAGES = ["decisions", "roadmap", "memory"] as const;
export type MovedPage = (typeof MOVED_PAGES)[number];

/** The `?moved=` a page lands with, or null when it names no page that was removed. */
export function movedPageOf(value: string | null): MovedPage | null {
  return (MOVED_PAGES as readonly string[]).includes(value ?? "") ? (value as MovedPage) : null;
}

const withQuery = (href: string, query: Record<string, string>) => `${href}?${new URLSearchParams(query).toString()}`;

/**
 * Where an old link to a removed page lands: a decision-log link narrowed to one requirement,
 * workflow or issue opens that item's decisions; every other one opens the Requirements list,
 * the roadmap one grouped by Now, Next and Later.
 */
export function movedTarget(slug: string, page: MovedPage, params: URLSearchParams): string {
  if (page === "decisions") {
    const requirement = params.get("requirement");
    if (requirement) return withQuery(requirementHref(slug, requirement), { tab: "decisions", moved: page });
    const workflow = params.get("workflow");
    if (workflow) return withQuery(workflowHref(slug, workflow), { tab: "decisions", moved: page });
    const issue = params.get("issue");
    if (issue) return withQuery(issueHref(slug, issue), { tab: "activity", moved: page });
  }
  if (page === "roadmap") return withQuery(requirementsHref(slug), { group: "roadmap", moved: page });
  return withQuery(requirementsHref(slug), { moved: page });
}

// REQ-33 BC-1, BC-8, BC-9: the project's Decisions, Roadmap, Memory, Questions and Lessons pages stood
// on their own and were removed; each record is read on the item it is about, and a lesson by no person.
// A link kept from before is sent where its record is read now, with `?moved=` naming the page it came
// from so the page it lands on says so.

import { approvalsHref } from "@/lib/routes/approvals";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref, requirementsHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";

const MOVED_PAGES = ["decisions", "roadmap", "memory", "questions", "lessons"] as const;
export type MovedPage = (typeof MOVED_PAGES)[number];

/** The `?moved=` a page lands with, or null when it names no page that was removed. */
export function movedPageOf(value: string | null): MovedPage | null {
  return (MOVED_PAGES as readonly string[]).includes(value ?? "") ? (value as MovedPage) : null;
}

const withQuery = (href: string, query: Record<string, string>) => `${href}?${new URLSearchParams(query).toString()}`;

/**
 * Where an old link to a removed page lands: a decision-log link narrowed to one requirement,
 * workflow or issue opens that item's decisions (a requirement's under its Activity, an issue's in its developer view, where every fold is open), any other the Requirements list; the roadmap one
 * opens the list's Map, whose columns are Now, Next and Later; the memory one the Dashboard's Memory section,
 * where the memories naming no item are read (an item's own are on its Memory tab); the questions one
 * Approvals, where a question waiting on the reader is answered (each item shows its own); the lessons
 * one the Dashboard, saying that lessons are read by Forge's agents and shown to no one.
 */
export function movedTarget(slug: string, page: MovedPage, params: URLSearchParams): string {
  if (page === "decisions") {
    const requirement = params.get("requirement");
    if (requirement) return withQuery(requirementHref(slug, requirement), { tab: "activity", moved: page });
    const workflow = params.get("workflow");
    if (workflow) return withQuery(workflowHref(slug, workflow), { tab: "decisions", moved: page });
    const issue = params.get("issue");
    if (issue) return withQuery(issueHref(slug, issue), { view: "developer", moved: page });
  }
  if (page === "roadmap") return withQuery(requirementsHref(slug), { group: "map", moved: page });
  if (page === "memory") return `${withQuery(`/projects/${encodeURIComponent(slug)}`, { moved: page })}#project-memory`;
  if (page === "questions") return withQuery(approvalsHref(slug), { moved: page });
  if (page === "lessons") return withQuery(`/projects/${encodeURIComponent(slug)}`, { moved: page });
  return withQuery(requirementsHref(slug), { moved: page });
}

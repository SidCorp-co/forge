"use client";

// The Table's view lives in the query string (ISS-436): every filter is read from it on each render,
// so a pinned-view click or Back restores the view without a remount, and each write merges into it
// so the host's `?tab=` survives (ISS-364/331). The search box writes after 300ms of quiet.

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useUrlParams } from "@/design";
import { statusesFromParam } from "../../derive";
import { type GroupBy, ISSUE_PRIORITIES, type IssueFilter, type IssuePriority, type IssueSort } from "../../types";

export const DEFAULT_FILTER: IssueFilter = "open";
const FILTERS: readonly string[] = ["open", "closed", "all"];
const GROUPINGS: readonly string[] = ["none", "status", "priority", "creator"];
const PRIORITIES: readonly string[] = ISSUE_PRIORITIES;
/** The params Clear all resets; sort and the host's own keys stay. */
const FILTER_PARAMS = ["q", "filter", "priority", "createdBy", "assignee", "status", "label", "module", "groupBy", "page"];

const oneOf = <T extends string>(raw: string | null, values: readonly string[], fallback: T): T => (raw && values.includes(raw) ? (raw as T) : fallback);

/** The list's view as the query string holds it, the setter that merges into it, and the search box. */
export function useIssueListParams(slug: string) {
  const pathname = usePathname() || `/projects/${slug}/issues`;
  const [sp, writeParams] = useUrlParams();
  const search = sp.toString() ? `?${sp.toString()}` : "";
  const q = (sp.get("q") ?? "").trim();
  const filter = oneOf<IssueFilter>(sp.get("filter"), FILTERS, DEFAULT_FILTER);
  const priority = oneOf<IssuePriority | "">(sp.get("priority"), PRIORITIES, "") || undefined;
  const createdBy = sp.get("createdBy") ?? "";
  const assignee = sp.get("assignee") ?? "";
  const label = sp.get("label") ?? "";
  const moduleId = sp.get("module") ?? "";
  const rawStatus = sp.get("status");
  const statusParam = statusesFromParam(rawStatus);
  const groupBy = oneOf<GroupBy>(sp.get("groupBy"), GROUPINGS, "none");
  const sort = (sp.get("sort") ?? "createdAt:desc") as IssueSort;
  const page = Math.max(1, Number(sp.get("page")) || 1);

  /** Merges `patch` into the query string ("" deletes a key), only while this route is the one showing (ISS-332). */
  const setParams = (patch: Record<string, string>) => {
    if (window.location.pathname.endsWith("/issues")) writeParams(patch);
  };

  // what the box holds; a change to `q` from outside (a pinned view, Back) replaces it
  const [typed, setTyped] = useState(q);
  const [seenQ, setSeenQ] = useState(q);
  if (q !== seenQ) {
    setSeenQ(q);
    if (q !== typed.trim()) setTyped(q);
  }
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const setRawQ = (text: string) => {
    setTyped(text);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setParams({ q: text.trim(), page: "" }), 300);
  };

  const isFiltered = q !== "" || filter !== DEFAULT_FILTER || !!priority || !!createdBy || !!assignee || !!label || !!moduleId || statusParam !== undefined;
  const clearAll = () => setParams(Object.fromEntries(FILTER_PARAMS.map((k) => [k, ""])));

  return { pathname, search, q, filter, priority, createdBy, assignee, label, moduleId, rawStatus, statusParam, groupBy, sort, page, setParams, rawQ: typed, setRawQ, isFiltered, clearAll };
}

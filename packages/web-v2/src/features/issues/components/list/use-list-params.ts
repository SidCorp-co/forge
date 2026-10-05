"use client";

// URL-as-state (ISS-436): every filter (q / filter / priority / assignee /
// groupBy / sort / page) is DERIVED from the live query string via
// `useLocationSearch`, and the setters write back with a shallow
// `replaceState` MERGE (never a rebuild — the host's `?tab=` and any sibling
// param survive, ISS-364/331). Because derivation is reactive, an external URL
// change — a pinned-view click on this same route, back/forward — restores the
// exact view without a remount (the old hydrate-once useState went stale).

import { decodeFilter, decodeNumber } from "@/features/shell";
import { notifyLocationChange, useLocationSearch } from "@/lib/utils/use-location-search";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { statusesFromParam } from "../../derive";
import {
  type GroupBy,
  ISSUE_PRIORITIES,
  type IssueFilter,
  type IssuePriority,
  type IssueSort,
} from "../../types";

const VALID_FILTERS: IssueFilter[] = ["open", "closed", "all"];
export const DEFAULT_FILTER: IssueFilter = "open";
const VALID_GROUP_BY: GroupBy[] = ["none", "status", "priority", "creator"];

/** The list's view as the query string holds it, the setter that merges into it, and the debounced search box. */
export function useIssueListParams(slug: string) {
  const pathname = usePathname() || `/projects/${slug}/issues`;
  const search = useLocationSearch();
  const sp = useMemo(() => new URLSearchParams(search), [search]);
  const q = sp.get("q") ?? "";
  const rawFilter = decodeFilter<IssueFilter>(sp, "filter", DEFAULT_FILTER);
  const filter = VALID_FILTERS.includes(rawFilter) ? rawFilter : DEFAULT_FILTER;
  const rawPriority = sp.get("priority") ?? "";
  const priority = (ISSUE_PRIORITIES as string[]).includes(rawPriority)
    ? (rawPriority as IssuePriority)
    : undefined;
  const createdBy = sp.get("createdBy") ?? "";
  const assignee = sp.get("assignee") ?? "";
  const label = sp.get("label") ?? "";
  const moduleId = sp.get("module") ?? "";
  const rawStatus = sp.get("status");
  const statusParam = useMemo(() => statusesFromParam(rawStatus), [rawStatus]);
  const rawGroupBy = decodeFilter<GroupBy>(sp, "groupBy", "none");
  const groupBy = VALID_GROUP_BY.includes(rawGroupBy) ? rawGroupBy : "none";
  const sort = decodeFilter<IssueSort>(sp, "sort", "createdAt:desc");
  const page = decodeNumber(sp, "page", 1);

  /** Shallow-merge `patch` into the live query string ("" deletes the key).
   *  Guarded to the issues route so an in-flight navigation to a child route
   *  is never clobbered (ISS-332). */
  const setParams = useCallback(
    (patch: Record<string, string>) => {
      if (typeof window === "undefined") return;
      if (!window.location.pathname.endsWith("/issues")) return;
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const qs = next.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${pathname}${qs ? `?${qs}` : ""}`,
      );
      notifyLocationChange();
    },
    [pathname],
  );

  const [rawQ, setRawQ] = useState(q);
  const lastAppliedQ = useRef(q);
  useEffect(() => {
    if (q !== lastAppliedQ.current) {
      lastAppliedQ.current = q;
      setRawQ(q);
    }
  }, [q]);
  useEffect(() => {
    const t = setTimeout(() => {
      const v = rawQ.trim();
      if (v === q) return;
      lastAppliedQ.current = v;
      setParams({ q: v, page: "" });
    }, 300);
    return () => clearTimeout(t);
  }, [rawQ, q, setParams]);

  const isFiltered =
    q !== "" ||
    filter !== DEFAULT_FILTER ||
    !!priority ||
    !!createdBy ||
    !!assignee ||
    !!label ||
    !!moduleId ||
    statusParam !== undefined;

  const clearAll = () =>
    setParams({
      q: "",
      filter: "",
      priority: "",
      createdBy: "",
      assignee: "",
      status: "",
      label: "",
      module: "",
      groupBy: "",
      page: "",
    });

  return {
    pathname,
    search,
    q,
    filter,
    priority,
    createdBy,
    assignee,
    label,
    moduleId,
    rawStatus,
    statusParam,
    groupBy,
    sort,
    page,
    setParams,
    rawQ,
    setRawQ,
    isFiltered,
    clearAll,
  };
}

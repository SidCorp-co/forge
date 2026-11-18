// The rail's groups open as an accordion, one per tier (ISS-1331): opening a group closes the others
// in its tier. The group holding the current page opens when the person navigates into it, and they
// can close it, or open another, which closes it. Their choice is the caller's and persists there; that
// they left the current page's group closed is this rail's own, for as long as they stay on the page.

import { useState } from "react";
import type { NavEntry, NavItemGroup } from "./nav-rail";

/** The person's open/closed choice per group key, merged over what the caller holds. */
export type GroupChoice = Record<string, boolean>;

// the rail's own guard, here so this module needs nothing from the rail but its types
const isNavGroup = (e: NavEntry): e is NavItemGroup => "items" in e;
const holds = (g: NavItemGroup, key: string) => g.items.some((it) => it.key === key);

/**
 * The one open group of a tier: the group holding the current page, unless the person closed it or
 * opened another since arriving on this page (`left`); else the group they last opened, else the
 * tier's default. A choice stored before the accordion that opens two reads as the first of them.
 */
export function openGroupOf(entries: NavEntry[], choice: GroupChoice, activeKey: string, left: boolean): string | null {
  const groups = entries.filter(isNavGroup);
  const holder = groups.find((g) => holds(g, activeKey));
  if (holder && !left) return holder.key;
  const chosen = groups.find((g) => choice[g.key] === true) ?? groups.find((g) => choice[g.key] === undefined && g.defaultOpen);
  return chosen?.key ?? null;
}

/** Each tier's open group, and the toggle that keeps one open per tier, writing the choice through `onChoose`. */
export function useNavAccordion(tiers: NavEntry[][], activeKey: string, choice: GroupChoice, onChoose?: (patch: GroupChoice) => void) {
  // whether the person closed the current page's group, or opened another, since arriving on this page
  const [left, setLeft] = useState(false);
  const [page, setPage] = useState(activeKey);
  if (page !== activeKey) {
    setPage(activeKey);
    setLeft(false);
  }
  const open = new Set(tiers.map((t) => openGroupOf(t, choice, activeKey, left && page === activeKey)).filter((k): k is string => k !== null));
  const toggle = (key: string) => {
    const groups = tiers.find((t) => t.some((e) => e.key === key))?.filter(isNavGroup) ?? [];
    const holder = groups.find((g) => holds(g, activeKey));
    const opening = !open.has(key);
    if (holder) setLeft(!(opening && holder.key === key));
    // the tier as the person now sees it: the one opened, every other closed, the current page's among them
    onChoose?.(Object.fromEntries(groups.map((g) => [g.key, opening && g.key === key])));
  };
  return { isOpen: (key: string) => open.has(key), toggle };
}

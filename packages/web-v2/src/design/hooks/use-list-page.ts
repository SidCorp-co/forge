"use client";

// The state every ListPage wires the same way: the search box in `?q=`, the rows it and the
// caller's filters leave, their groups and which are folded, the row open in the peek (`?peek=`),
// j/k/Enter over the rows that show, and the full page a row opens remembering the list it left.

import { useRouter } from "next/navigation";
import { rememberListOrigin } from "../patterns/detail-header";
import { type GroupFold, type ListGroup, useGroupFold, visibleRows } from "../patterns/grouped-list";
import { type PeekState, usePeek, usePeekKeys } from "../patterns/peek-panel";
import { useUrlParams } from "./use-url-params";

export interface ListPageSpec<R> {
  /** Every row the page read, before any narrowing. */
  rows: readonly R[];
  keyOf: (row: R) => string;
  /** The words the search box matches, any case; a list with no search box leaves it out. */
  searchOf?: (row: R) => string;
  /** The rest of the narrowing: the list filter the chat sets, a toolbar select's value in `params`. */
  narrow?: (row: R, params: URLSearchParams) => boolean;
  /** The groups the narrowed rows read in. */
  groupsOf: (rows: R[]) => ListGroup<R>[];
  /** Where the folded groups are remembered. */
  foldKey: string;
  /** The rows j/k step through, when not those of the open groups. */
  stepsOf?: (groups: ListGroup<R>[], rows: R[]) => R[];
  /** A row's full page. */
  hrefOf: (key: string) => string;
  /** The list a full page goes back to, or null where the page is not a list of its own. */
  origin: string | null;
}

export interface ListPageState<R> {
  params: URLSearchParams;
  setParams: ReturnType<typeof useUrlParams>[1];
  /** Spread onto `ListSearch`. */
  search: { value: string; onChange: (text: string) => void };
  /** The rows the search and the filters leave. */
  rows: R[];
  groups: ListGroup<R>[];
  fold: GroupFold;
  peek: PeekState;
  /** Opens a row in the peek, or closes it when it is the open one. */
  togglePeek: (key: string) => void;
  openFull: (key: string) => void;
}

export function useListPage<R>({ rows: all, keyOf, searchOf, narrow, groupsOf, foldKey, stepsOf, hrefOf, origin }: ListPageSpec<R>): ListPageState<R> {
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const text = params.get("q") ?? "";
  const needle = text.trim().toLowerCase();
  const rows = all.filter((r) => (!needle || !searchOf || searchOf(r).toLowerCase().includes(needle)) && (!narrow || narrow(r, params)));
  const groups = groupsOf(rows);
  const fold = useGroupFold(foldKey);
  const steps = stepsOf ? stepsOf(groups, rows) : visibleRows(groups, fold);
  const peek = usePeek(steps.map(keyOf), all.map(keyOf));
  const openFull = (key: string) => {
    if (origin) rememberListOrigin(origin);
    router.push(hrefOf(key));
  };
  usePeekKeys(peek, openFull);
  return {
    params,
    setParams,
    search: { value: text, onChange: (q) => setParams({ q: q || null }) },
    rows,
    groups,
    fold,
    peek,
    togglePeek: (key) => peek.set(key === peek.open ? null : key),
    openFull,
  };
}

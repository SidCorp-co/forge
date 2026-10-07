import {
  isAwaitingReply,
  isRealFailure,
  sessionKind,
  AGENT_SESSION_KINDS,
  SESSION_KIND_KEY,
  type AgentSessionDisplayStatus,
  type AgentSessionKind,
  type SessionFilter,
  type SessionRow,
} from "../types";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";

// ISS-664 — "waiting" leads the tab order: it's the one the owner scans for
// first ("who needs me"), distinct from `attention` (genuine job failures).
export const FILTERS: SessionFilter[] = ["all", "waiting", "running", "queued", "attention"];
export const FILTER_KEY: Record<SessionFilter, ProductCopyKey> = {
  all: "sessions.filter.all",
  waiting: "sessions.filter.waiting",
  running: "sessions.filter.running",
  queued: "sessions.filter.queued",
  attention: "sessions.filter.attention",
};

// ISS-465 — kind dimension on top of the status filter. Defaults to "all" so
// existing readers see the same set. The row states its species, so each one
// is its own tab.
export type KindFilter = "all" | AgentSessionKind;
export const KIND_FILTERS: KindFilter[] = ["all", ...AGENT_SESSION_KINDS];
export const KIND_KEY: Record<KindFilter, ProductCopyKey> = {
  all: "sessions.kind.all",
  ...SESSION_KIND_KEY,
};

export function matchesKind(kind: KindFilter, row: SessionRow): boolean {
  return kind === "all" || sessionKind(row) === kind;
}

export function matchesFilter(filter: SessionFilter, row: SessionRow, display: AgentSessionDisplayStatus): boolean {
  switch (filter) {
    case "waiting":
      // ISS-664 — a finished interactive chat awaiting the owner's reply.
      // Deliberately distinct from `queued` (a pipeline session awaiting a
      // runner also carries `status:'idle'` in some capacity-blocked states,
      // but `isAwaitingReply` only matches interactive chats).
      return isAwaitingReply(row);
    case "running":
      return display === "running" || display === "stalled";
    case "queued":
      return row.status === "queued" || row.status === "idle";
    case "attention":
      // ISS-322 — only GENUINE failures + live-stalled (about-to-be-reaped)
      // sessions need attention. A terminal `cancelled_stale`/lifecycle cancel
      // is benign cleanup (`swept`), so it no longer lands here.
      return isRealFailure(display, row.failureReason) || display === "stalled";
    default:
      return true;
  }
}

/** The header strip's figures over one page of sessions: live, queued, stalled and the median queue wait. */
export function sessionStats(rows: SessionRow[], displays: AgentSessionDisplayStatus[], now: number) {
  let active = 0;
  let queued = 0;
  let zombies = 0;
  const waits: number[] = [];
  rows.forEach((r, i) => {
    const d = displays[i];
    if (d === "running") active += 1;
    if (r.status === "queued" || r.status === "idle") {
      queued += 1;
      // Time a still-queued session has been waiting for a runner.
      const since = r.dispatchedAt ?? r.createdAt;
      const ms = since ? now - new Date(since).getTime() : NaN;
      if (Number.isFinite(ms) && ms >= 0) waits.push(ms);
    }
    if (d === "stalled") zombies += 1;
  });
  // Median wait across queued sessions (draft "Median wait" metric).
  let medianWaitMs = 0;
  if (waits.length > 0) {
    waits.sort((a, b) => a - b);
    const mid = Math.floor(waits.length / 2);
    medianWaitMs = waits.length % 2 ? waits[mid] : Math.round((waits[mid - 1] + waits[mid]) / 2);
  }
  return { active, queued, zombies, medianWaitMs };
}

export type SessionStats = ReturnType<typeof sessionStats>;

/** How many rows of the page each status tab holds. */
export function filterCounts(rows: SessionRow[], displays: AgentSessionDisplayStatus[]): Record<SessionFilter, number> {
  const c: Record<SessionFilter, number> = {
    all: rows.length,
    waiting: 0,
    running: 0,
    queued: 0,
    attention: 0,
  };
  rows.forEach((r, i) => {
    for (const f of FILTERS) {
      if (f !== "all" && matchesFilter(f, r, displays[i])) c[f] += 1;
    }
  });
  return c;
}

/** How many rows of the page each kind tab holds, counted before the kind filter. */
export function kindCounts(rows: SessionRow[]): Record<KindFilter, number> {
  const c: Record<KindFilter, number> = {
    all: rows.length,
    master: 0,
    run_session: 0,
    pipeline: 0,
    chat: 0,
  };
  for (const r of rows) c[sessionKind(r)] += 1;
  return c;
}

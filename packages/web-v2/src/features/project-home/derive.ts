// What the project home's Running and At risk tables list, read from the one project status core
// answers (`GET /api/projects/:id/status`). Nothing here decides what is stuck or late: core's
// `stuck.items` (the standing read, REQ-48 BC-8) lead, then its `late.items`, each listed as it comes.

import type { ForecastLate } from "@forge/contracts/forecast";
import type { ProjectStatus, StatusInFlightIssue, StatusStuckItem } from "@forge/contracts/project-status";
import { feedbackHref } from "@/lib/routes/feedback";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";

/** The issues a job or run is on right now, in core's order. */
export const runningRows = (status: ProjectStatus | undefined): StatusInFlightIssue[] => status?.inFlight.running ?? [];

export type AtRiskReason =
  | { kind: "stuck"; reason: string; note: string | null }
  | { kind: "late"; late: ForecastLate };

export interface AtRiskRow {
  entity: StatusStuckItem["kind"] | "release";
  key: string;
  title: string;
  href: string;
  reasons: AtRiskReason[];
}

/** Stuck items (oldest first, as core orders them), then late items (longest past first); one row per record. */
export function atRiskRows(status: ProjectStatus | undefined, slug: string): AtRiskRow[] {
  if (!status) return [];
  const rows = new Map<string, AtRiskRow>();
  for (const s of status.stuck?.items ?? []) {
    const reason: AtRiskReason = { kind: "stuck", reason: s.reason, note: s.note };
    rows.set(`${s.kind}:${s.key}`, { entity: s.kind, key: s.key, title: s.title, href: s.href, reasons: [reason] });
  }
  const hrefOf = { requirement: requirementHref, feedback: feedbackHref, release: releaseHref } as const;
  const late = [...status.late.items].sort((a, b) => b.late.byMinutes - a.late.byMinutes);
  for (const l of late) {
    const reason: AtRiskReason = { kind: "late", late: l.late };
    const held = rows.get(`${l.kind}:${l.key}`);
    if (held) held.reasons.push(reason);
    else rows.set(`${l.kind}:${l.key}`, { entity: l.kind, key: l.key, title: l.title, href: hrefOf[l.kind](slug, l.key), reasons: [reason] });
  }
  return [...rows.values()];
}

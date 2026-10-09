// What the project home's Running and At risk tables list, read from the one project status core
// answers (`GET /api/projects/:id/status`). Nothing here decides what is late: core's `late.items`
// are listed as they come, and a requirement is short only where its own criteria count says so.

import type { ForecastLate } from "@forge/contracts/forecast";
import type { ProjectStatus, StatusInFlightIssue } from "@forge/contracts/project-status";
import { feedbackHref } from "@/lib/routes/feedback";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";

/** The issues a job or run is on right now, in core's order. */
export const runningRows = (status: ProjectStatus | undefined): StatusInFlightIssue[] => status?.inFlight.running ?? [];

/** The states a requirement has been built in and so has criteria the running build can fall short of. */
const BUILT_STATES: ReadonlySet<string> = new Set(["delivered", "accepted"]);

export type AtRiskReason = { kind: "late"; late: ForecastLate } | { kind: "short"; proven: number; total: number };

export interface AtRiskRow {
  entity: "requirement" | "feedback" | "release";
  key: string;
  title: string;
  href: string;
  reasons: AtRiskReason[];
}

/** Late items (longest past first), then delivered requirements with a criterion not proven; one row per record. */
export function atRiskRows(status: ProjectStatus | undefined, slug: string): AtRiskRow[] {
  if (!status) return [];
  const rows = new Map<string, AtRiskRow>();
  const hrefOf = { requirement: requirementHref, feedback: feedbackHref, release: releaseHref } as const;
  const late = [...status.late.items].sort((a, b) => b.late.byMinutes - a.late.byMinutes);
  for (const l of late) {
    rows.set(`${l.kind}:${l.key}`, { entity: l.kind, key: l.key, title: l.title, href: hrefOf[l.kind](slug, l.key), reasons: [{ kind: "late", late: l.late }] });
  }
  for (const r of status.requirements.items) {
    if (!BUILT_STATES.has(r.state) || r.criteria.proven >= r.criteria.total) continue;
    const reason: AtRiskReason = { kind: "short", proven: r.criteria.proven, total: r.criteria.total };
    const held = rows.get(`requirement:${r.key}`);
    if (held) held.reasons.push(reason);
    else rows.set(`requirement:${r.key}`, { entity: "requirement", key: r.key, title: r.title, href: requirementHref(slug, r.key), reasons: [reason] });
  }
  return [...rows.values()];
}

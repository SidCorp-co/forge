// What the home draws from its one read (`GET /api/projects/:id/home`): each stage's parts, the
// Delivery board's columns. Every number is the read's; this only groups and
// places them, so a part's count always sums back to the figure its stage shows.

import type { HomeCount, HomeIssue, ProjectHome } from "@forge/contracts/project-home";
import { DEBT_KIND_TONES, type DebtKind } from "@forge/contracts/cleanup";
import type { IssueStatus } from "@forge/contracts/issue-machine";
import { ISSUE_STATUS_TONES } from "@forge/contracts/issue-vocabulary";
import { RELEASE_STATE_TONES, type ReleaseState } from "@forge/contracts/releases";
import { REQUIREMENT_STATE_TONES, type RequirementState } from "@forge/contracts/requirements";
import type { LegendTone } from "@/design";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";

export const STAGE_IDS = ["product", "delivery", "release", "audit"] as const;
export type StageId = (typeof STAGE_IDS)[number];

/**
 * One part of a stage's bar. Its tone is what the part means, read from the contract tone map of the
 * states it gathers, the same tone that state's badge wears on every screen (REQ-12 BC-3): a failed
 * release is red wherever it is drawn, never the colour its place in the bar happens to get.
 */
export interface Part {
  key: string;
  label: ProductCopyKey;
  count: number;
  tone: LegendTone;
}

interface PartGroup<K extends string> {
  key: string;
  label: ProductCopyKey;
  of: readonly K[];
  tone: LegendTone;
}

function partsOf<K extends string>(counts: readonly HomeCount<K>[], groups: readonly PartGroup<K>[]): Part[] {
  const tally = new Map(counts.map((c) => [c.key, c.count]));
  return groups.map((g) => ({ key: g.key, label: g.label, tone: g.tone, count: g.of.reduce((n, k) => n + (tally.get(k) ?? 0), 0) }));
}

const PRODUCT_PARTS: PartGroup<RequirementState>[] = [
  { key: "building", label: "home.part.building", of: ["in_delivery"], tone: REQUIREMENT_STATE_TONES.in_delivery },
  { key: "agreed", label: "home.part.agreed", of: ["agreed"], tone: REQUIREMENT_STATE_TONES.agreed },
  { key: "done", label: "home.part.done", of: ["delivered", "accepted"], tone: REQUIREMENT_STATE_TONES.accepted },
  { key: "draft", label: "home.part.draft", of: ["draft"], tone: REQUIREMENT_STATE_TONES.draft },
  { key: "deferred", label: "home.part.deferred", of: ["deferred"], tone: REQUIREMENT_STATE_TONES.deferred },
];

/** The Delivery board's columns, each the statuses it holds; every open status is in one. */
export const DELIVERY_COLUMNS: PartGroup<IssueStatus>[] = [
  { key: "queued", label: "home.part.queued", of: ["draft", "open", "reopen", "approved"], tone: ISSUE_STATUS_TONES.open },
  { key: "building", label: "home.part.building", of: ["in_progress"], tone: ISSUE_STATUS_TONES.in_progress },
  // held reads as stopped by something outside the work, not as queued: queued already wears neutral
  { key: "held", label: "home.part.held", of: ["on_hold", "needs_info"], tone: "blocked" },
  { key: "landed", label: "home.part.landed", of: ["awaiting_release"], tone: ISSUE_STATUS_TONES.awaiting_release },
];

const RELEASE_PARTS: PartGroup<ReleaseState>[] = [
  { key: "shipped", label: "home.part.shipped", of: ["shipped"], tone: RELEASE_STATE_TONES.shipped },
  { key: "going", label: "home.part.going", of: ["in_progress", "awaiting_approval", "returned", "landed"], tone: RELEASE_STATE_TONES.in_progress },
  { key: "failed", label: "home.part.failed", of: ["failed"], tone: RELEASE_STATE_TONES.failed },
  { key: "aborted", label: "home.part.aborted", of: ["aborted"], tone: RELEASE_STATE_TONES.aborted },
];

const AUDIT_PARTS: PartGroup<DebtKind>[] = [
  { key: "debt", label: "home.kind.debt", of: ["debt"], tone: DEBT_KIND_TONES.debt },
  { key: "simplify", label: "home.kind.simplify", of: ["simplify"], tone: DEBT_KIND_TONES.simplify },
  { key: "red", label: "home.kind.red", of: ["red"], tone: DEBT_KIND_TONES.red },
];

export const stageParts = (home: ProjectHome): Record<StageId, Part[]> => ({
  product: partsOf(home.product.byState, PRODUCT_PARTS),
  delivery: partsOf(home.delivery.byStatus, DELIVERY_COLUMNS),
  release: partsOf(home.release.byState, RELEASE_PARTS),
  audit: partsOf(home.audit.byKind, AUDIT_PARTS),
});

/** Each board column's issues, in the read's order (newest write first). */
export function boardOf(issues: readonly HomeIssue[]): Map<string, HomeIssue[]> {
  const columnOf = new Map(DELIVERY_COLUMNS.flatMap((c) => c.of.map((s) => [s, c.key] as const)));
  const board = new Map(DELIVERY_COLUMNS.map((c) => [c.key, [] as HomeIssue[]]));
  for (const i of issues) board.get(columnOf.get(i.status) ?? "")?.push(i);
  return board;
}

/** How far along build → test → release an issue is: 0 before building, 3 once it landed. */
export function trackOf(i: Pick<HomeIssue, "status" | "step">): number {
  if (i.status === "awaiting_release") return 3;
  if (i.status !== "in_progress" && i.status !== "on_hold" && i.status !== "needs_info") return 0;
  return i.step === "release" ? 3 : i.step === "test" ? 2 : i.step === "build" ? 1 : 0;
}

export const isHighPriority = (priority: string) => priority === "high" || priority === "urgent" || priority === "critical";


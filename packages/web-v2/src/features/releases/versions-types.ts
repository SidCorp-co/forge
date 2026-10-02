import type { ReleaseAttempt, ReleaseBoundsReading } from "./types";

export const VERSION_STATUSES = [
  "in_progress",
  "awaiting_approval",
  "returned",
  "shipped",
  "rolled_back",
  "failed",
  "aborted",
] as const;
export type ReleaseVersionStatus = (typeof VERSION_STATUSES)[number];

export const VERSION_FILTERS = ["all", "awaiting_approval", "live", "rolled_back"] as const;
export type ReleaseVersionFilter = (typeof VERSION_FILTERS)[number];

export interface ReleaseApprovalEvidence {
  environment: string;
  commit: string;
  reading: string;
}

export interface ReleaseApproval {
  id: string;
  runId: string;
  requestedBy: { id: string; name: string };
  requestedAt: string;
  evidence: ReleaseApprovalEvidence;
  note: string | null;
  decision: "approved" | "returned" | null;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  reason: string | null;
}

export interface ReleaseStageReading {
  stage: ReleaseAttempt["stage"];
  verdict: ReleaseAttempt["verdict"];
  settled: boolean;
}

export interface ReleaseVersionRow {
  version: string;
  runId: string;
  runStatus: string;
  status: ReleaseVersionStatus;
  current: boolean;
  openedAt: string;
  releasedAt: string | null;
  issueCount: number;
  /** The project document's `release.approval.required`: no production act before an admin approves. */
  approvalRequired: boolean;
  approval: ReleaseApproval | null;
  stages: ReleaseStageReading[];
}

export interface ReleaseDraftIssue {
  id: string;
  key: string;
  title: string;
  section: string | null;
}

export interface ReleaseBlockerReading {
  code: string;
  message: string;
}

export interface ReleaseDraft {
  version: string;
  issues: ReleaseDraftIssue[];
  blockers: ReleaseBlockerReading[];
}

export interface ReleaseEnvironmentRow {
  name: string;
  tier: "production" | "staging" | "preview" | "dev";
  url: string | null;
  version: string | null;
  /** The branch it deploys from; the list comes back in promotion order along these. */
  deploysFrom: string | null;
  trigger: "on-land" | "on-request" | "provider" | "external";
}

/** The project's always-injected `release-procedure` knowledge entry. */
export interface ReleaseProcedure {
  slug: string;
  title: string;
  body: string;
  updatedAt: string;
}

/** `GET /api/projects/:projectId/releases`. */
export interface ReleaseVersionList {
  versions: ReleaseVersionRow[];
  draft: ReleaseDraft | null;
  approvalRequired: boolean;
  procedure: ReleaseProcedure | null;
  counts: { all: number; awaitingApproval: number; live: number; rolledBack: number };
  environments: ReleaseEnvironmentRow[];
  environmentsRead: { ok: true } | { ok: false; reason: string };
  landingBranch: string | null;
}

export interface ReleaseChangelogEntry {
  issueId: string;
  key: string;
  userFacing: string;
  technical: string | null;
}

export interface ReleaseChangelogSection {
  section: string;
  entries: ReleaseChangelogEntry[];
}

/** `GET /api/projects/:projectId/releases/:version`. */
export interface ReleaseVersionDetail extends ReleaseVersionRow {
  changelog: ReleaseChangelogSection[];
  withoutNotes: Array<{ issueId: string; key: string; title: string }>;
  attempts: ReleaseAttempt[];
  bounds: ReleaseBoundsReading;
  approvals: ReleaseApproval[];
  environment: string | null;
}

export type ReleaseDecisionBody = { decision: "approve" } | { decision: "return"; reason: string };

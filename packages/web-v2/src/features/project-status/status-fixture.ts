import type { ProjectStatus } from "@forge/contracts/project-status";

// A project status as core answers it, at a fixed moment, for the report and dashboard tests.

export const AT = "2026-10-07T10:00:00.000Z";
const RELEASED = "2026-10-06T09:30:00.000Z";

const release = {
  version: "0.2.0",
  releasedAt: RELEASED,
  headline: "Saved boards keep every card",
  issueCount: 2,
  requirements: ["REQ-3"],
  contents: [
    {
      requirement: { key: "REQ-3", title: "The board keeps its cards" },
      issues: [
        { key: "ISS-11", title: "Saved boards keep every card", status: "closed", proof: "proven" as const },
        { key: "ISS-12", title: "Export keeps the order", status: "closed", proof: "unrecorded" as const },
      ],
    },
  ],
  verified: { level: "some_criteria" as const, proven: 1, total: 2, check: "probed" as const },
};

export const STATUS: ProjectStatus = {
  projectId: "p1",
  slug: "hop",
  name: "HOP",
  asOf: AT,
  days: 7,
  viewer: { id: "u1", name: "Lan" },
  shipped: {
    asOf: AT,
    since: "2026-09-30T10:00:00.000Z",
    latest: release,
    releases: [release],
    releaseCount: 1,
    issueCount: 2,
    requirementsShipped: [{ key: "REQ-3", title: "The board keeps its cards", at: RELEASED }],
  },
  inFlight: {
    asOf: AT,
    byStatus: [
      { status: "open", count: 3 },
      { status: "in_progress", count: 1 },
    ],
    open: 4,
    running: [
      {
        key: "ISS-20",
        title: "Referral screens",
        status: "in_progress",
        waitingOn: { kind: "agent", who: "Master", act: "build", rule: "a run is on it", ref: null, dueAt: null },
      },
    ],
    runningCount: 1,
    truncated: false,
  },
  waits: {
    asOf: AT,
    people: [
      {
        area: "releases",
        entity: "release",
        key: "0.3.0",
        title: "Release 0.3.0",
        waitingOn: { kind: "you", who: "You", act: "approve the release", rule: "an approval is asked", ref: null, dueAt: null },
        touchedAt: AT,
      },
    ],
    peopleCount: 1,
    needsYou: 1,
  },
  requirements: {
    asOf: AT,
    proven: 3,
    total: 8,
    byState: [{ state: "in_delivery", count: 1 }],
    items: [
      {
        key: "REQ-4",
        title: "Referrals",
        state: "in_delivery",
        criteria: { proven: 3, total: 8 },
        issues: { shipped: 1, live: 4 },
        waitingOn: { kind: "issue", who: "Issues", act: "Running 1 of 4", rule: "agreed and its issues are being worked", ref: null, dueAt: null },
        delivery: null,
      },
    ],
  },
  nextRelease: { asOf: AT, version: "0.3.0", issueCount: 3, requirements: ["REQ-4"], forecast: null, cut: { who: "A project admin", act: "cut 0.3.0" } },
  late: {
    asOf: AT,
    items: [{ kind: "requirement", key: "REQ-4", title: "Referrals", late: { reason: "p85_passed", since: "2026-10-07T08:00:00.000Z", byMinutes: 120 } }],
  },
  roadmap: {
    asOf: AT,
    now: [{ key: "REQ-4", title: "Referrals", state: "in_delivery", delivery: null, deferral: null }],
    next: [],
    later: [
      { key: "REQ-7", title: "Printing", state: "deferred", delivery: null, deferral: { reason: "waits for the new layout", targetPhase: "phase 2", deferredAt: AT } },
      { key: "REQ-9", title: "Export to a sheet", state: "draft", delivery: null, deferral: null },
    ],
  },
};

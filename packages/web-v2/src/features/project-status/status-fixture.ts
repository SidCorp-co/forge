import { RULE, say, sentence, waitingOn } from "@/test/said";
import type { Said } from "@forge/contracts/said";
import type { ProjectStatus } from "@forge/contracts/project-status";

// A project status as core answers it, at a fixed moment, for the report and dashboard tests.

/** A next release's turn as core sends it: who and the act in English beside what it said. */
export const turn = (who: Said, act: Said) => ({ who: sentence(who), act: sentence(act), says: { who, act } });

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
  verified: { level: "some_criteria" as const, proven: 1, total: 2, check: "probed" as const, provider: null },
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
        waitingOn: waitingOn("agent", { who: say("standing.who.master"), act: say("issues.standing.act.working"), rule: RULE }),
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
        waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.approveReleaseV", { v: "0.3.0" }), rule: RULE }),
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
        progress: { total: 4, shipped: 1, awaitingRelease: 1, toDo: 2 },
        waitingOn: waitingOn("issue", { who: say("standing.who.issues"), act: say("standing.act.running", { a: 1, b: 4 }), rule: say("requirements.rule.moving") }),
        delivery: null,
      },
    ],
  },
  nextRelease: { asOf: AT, version: "0.3.0", state: "draft", progress: { total: 3, shipped: 0, awaitingRelease: 3, toDo: 0 }, requirements: ["REQ-4"], forecast: null, turn: turn(say("standing.who.named", { name: "Minh" }), say("standing.act.cut", { v: "0.3.0", more: null })), behind: null },
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

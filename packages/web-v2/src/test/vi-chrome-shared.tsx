import { EnumBadge, StatusBadge } from "@/design";
import { DecisionsPanel } from "@/features/comments/components/decisions-panel";
import { MockupsPanel } from "@/features/mockups/components/mockups-panel";
import { GateLine } from "@/features/releases/components/release-bits";
import { WhatChanges } from "@/features/releases/components/release-changes";
import type { Said } from "@forge/contracts/said";
import { gateView, say, sentence } from "./said";
import { Seeded } from "./vi-chrome-requirements";
import type { ShellScreen } from "./vi-chrome-shell";

// The pieces the screen lanes share, for the vi walking test: the Decisions and Mockups tabs, the
// badges of the approval, reconciliation, build-gate, integration and data-policy families, and core's
// release-gate and risk sentences. Content is placeholder words.

const P = "p1";
const AT = "2026-10-07T10:00:00Z";

const comment = (id: string, over: Record<string, unknown>) => ({
  id,
  target: { scope: "requirement", ref: "REQ-1" },
  intent: "decision",
  body: null,
  format: "markdown",
  decision: null,
  parentId: null,
  author: { id: "u1", name: "Lan", agency: "human" },
  withheld: false,
  edited: false,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});
const decisions = () => (
  <Seeded
    data={[
      [
        ["entity-decisions", P, "requirement", "REQ-1"],
        {
          comments: [
            comment("d1", { decision: { decision: "Chon kho", reason: "Re hon", options: ["Kho A", "Kho B"], authority: "Lan", reversedWhen: "Khi doi" }, edited: true }),
            comment("d2", { body: null, withheld: true, author: { id: null, name: null, agency: "agent" } }),
          ],
          returned: 2,
        },
      ],
      [["entity-decisions", P, "feedback", "FB-1"], { comments: [], returned: 0 }],
    ]}
  >
    <DecisionsPanel projectId={P} scope="requirement" targetRef="REQ-1" />
    <DecisionsPanel projectId={P} scope="feedback" targetRef="FB-1" />
  </Seeded>
);

const mockup = (key: string, over: Record<string, unknown>) => ({
  id: key,
  key,
  target: { type: "requirement", key: "REQ-1", revision: 2 },
  kind: "wireframe",
  name: "bang.json",
  mime: "application/json",
  size: 10,
  caption: "Bang",
  status: "proposed",
  proposedBy: "u1",
  proposedByName: null,
  proposedAgency: "agent",
  createdAt: AT,
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  reason: null,
  pinned: null,
  url: `/m/${key}`,
  can: { accept: true, return: true, withdraw: true },
  ...over,
});
const mockups = () => (
  <Seeded
    data={[
      [["mockups", P, "requirement", "REQ-1"], { mockups: [mockup("MK-1", {}), mockup("MK-2", { kind: "html", status: "accepted", reason: "Dep", pinned: { revision: 2 } }), mockup("MK-3", { kind: "api_example", status: "returned", reason: "Sai" })], returned: 3, open: 1 }],
      [["mockups", P, "feedback", "FB-1"], { mockups: [], returned: 0, open: 0 }],
    ]}
  >
    <MockupsPanel projectId={P} target={{ type: "requirement", key: "REQ-1", revision: 2 }} />
    <MockupsPanel projectId={P} target={{ type: "feedback", key: "FB-1" }} />
  </Seeded>
);

const badges = () => (
  <>
    {(["pending", "approved", "returned"] as const).map((v) => <StatusBadge key={v} family="release" value={v} />)}
    {(["reconciled", "open"] as const).map((v) => <StatusBadge key={v} family="reconciliation" value={v} />)}
    {(["open", "held"] as const).map((v) => <StatusBadge key={v} family="buildGate" value={v} />)}
    {(["confirmed", "unconfirmed"] as const).map((v) => <StatusBadge key={v} family="integration" value={v} />)}
    {(["off", "redact", "no_egress"] as const).map((v) => <StatusBadge key={v} family="dataPolicy" value={v} />)}
    {(["in_progress", "waiting_on_you", "done"] as const).map((v) => <StatusBadge key={v} family="thread" value={v} />)}
    {(["proposed", "accepted", "returned", "withdrawn"] as const).map((v) => <StatusBadge key={v} family="mockup" value={v} />)}
    {(["friction", "bug", "skill_gap", "unclear_step", "redundant_step", "learning", "suggestion"] as const).map((v) => <EnumBadge key={v} family="agentReportKind" value={v} />)}
    {(["skill", "prompt", "tool", "doc", "orientation", "pipeline", "other"] as const).map((v) => <EnumBadge key={v} family="agentReportTarget" value={v} />)}
    {(["mention", "pipeline_wedge", "feedback_shipped", "channel_gate_pending"] as const).map((v) => <EnumBadge key={v} family="notificationType" value={v} />)}
    {(["image", "wireframe", "html", "sketch", "api_example"] as const).map((v) => <EnumBadge key={v} family="mockupKind" value={v} />)}
    <EnumBadge family="feedbackKind" value="bug" />
    <EnumBadge family="feedbackRoute" value="issue" />
    <EnumBadge family="feedbackTarget" value="screen" />
    <EnumBadge family="landingSurface" value="ui" />
  </>
);

/** Core's gate readings as `release-batch/release-gates.ts` says them, one per reading shape. */
type GateSaid = { code: string; kind: "blocker" | "warning"; title: Said; sentence: Said; who: Said; act: Said };
const ADMIN = say("standing.who.holderOf", { perm: "project.admin" });
const MASTER = say("standing.who.master");
const GATE = say("standing.who.releaseGate");
const keys = (k: string) => say("standing.gate.subject.keys", { keys: k });
const count = (n: number) => say("standing.gate.subject.count", { n, issues: n === 1 ? "issue" : "issues" });
const owes = (key: string, list: string) => say("standing.gate.owes", { key, word: list.includes(",") ? "criteria" : "criterion", list });
const g = (code: string, kind: GateSaid["kind"], title: Said, sentence: Said, who: Said, act: Said): GateSaid => ({ code, kind, title, sentence, who, act });
export const GATE_SENTENCES: GateSaid[] = [
  g("NO_RELEASE_GATE", "blocker", say("standing.gate.title.noGate"), say("standing.gate.noGate"), ADMIN, say("standing.act.declareProduction")),
  g("RELEASE_TARGET_UNDECLARED", "blocker", say("standing.gate.title.nowhere"), say("standing.gate.nowhere"), ADMIN, say("standing.act.declareTarget")),
  g("CLAIM_CONFLICT", "blocker", say("standing.gate.title.claimed"), say("standing.gate.claimed", { subject: keys("ISS-1, ISS-2"), verb: "are", obj: "them" }), ADMIN, say("standing.act.cutWaiting")),
  g("CLAIM_CONFLICT", "blocker", say("standing.gate.title.claimed"), say("standing.gate.claimed", { subject: keys("ISS-1"), verb: "is", obj: "it" }), ADMIN, say("standing.act.cutWaiting")),
  g("RELEASE_ROSTER_EMPTY", "blocker", say("standing.gate.title.empty"), say("standing.gate.nearGate", { n: 2, issues: "issues", verb: "stand", their: "their" }), MASTER, say("standing.act.bringIssueToGate")),
  g("RELEASE_ROSTER_EMPTY", "blocker", say("standing.gate.title.empty"), say("standing.gate.empty"), MASTER, say("standing.act.bringIssueToGate")),
  g("RELEASE_ROSTER_OVERSIZE", "blocker", say("standing.gate.title.oversize"), say("standing.gate.oversize", { n: 63, issues: "issues", verb: "are", limit: 50 }), ADMIN, say("standing.act.splitRelease")),
  g("RELEASE_ROSTER_OVERSIZE", "blocker", say("standing.gate.title.oversize"), say("standing.gate.oversizeUncounted", { limit: 50 }), ADMIN, say("standing.act.splitRelease")),
  g("RELEASE_RECORD_MISSING", "blocker", say("standing.gate.title.noteMissing"), say("standing.gate.noteMissing", { subject: say("standing.gate.subject.more", { keys: "ISS-6, ISS-7, ISS-8, ISS-9, ISS-10", n: 2 }), verb: "have" }), MASTER, say("standing.act.writeReleaseNote", { on: say("standing.gate.on", { subject: keys("ISS-6, ISS-7") }) })),
  g("RELEASE_WORK_UNMERGED", "blocker", say("standing.gate.title.unmerged"), say("standing.gate.unmerged", { subject: count(3), verb: "have", their: "their" }), MASTER, say("standing.act.markMerge", { on: say("standing.gate.on", { subject: count(3) }) })),
  g("RELEASE_WORK_UNMERGED", "blocker", say("standing.gate.title.unmerged"), say("standing.gate.unmerged", { subject: keys("ISS-6"), verb: "has", their: "its" }), MASTER, say("standing.act.markMerge", { on: null })),
  g("RELEASE_PROBES_UNREADABLE", "blocker", say("standing.gate.title.unprovable"), say("standing.gate.unprovable"), ADMIN, say("standing.act.declareProbe")),
  g("RELEASE_POOL_EMPTY", "blocker", say("standing.gate.title.noRunner"), say("standing.gate.noRunner"), ADMIN, say("standing.act.pairRunner")),
  g("NO_RUNNER_ONLINE", "blocker", say("standing.gate.title.noRunnerOnline"), say("standing.gate.noRunnerOnline"), ADMIN, say("standing.act.runnerOnline")),
  g("BATCH_IN_FLIGHT", "blocker", say("standing.gate.title.running"), say("standing.gate.running"), GATE, say("standing.act.releaseRunning")),
  g("RELEASE_CRITERIA_UNEARNED", "blocker", say("standing.gate.title.unearned"), say("standing.gate.unearned", { owes: [owes("ISS-4", "1, 2"), owes("ISS-5", "3")] }), MASTER, say("standing.act.judgeCriteria")),
  g("RELEASE_CRITERIA_UNEARNED", "blocker", say("standing.gate.title.unearned"), say("standing.gate.unearned", { owes: [say("standing.gate.subject.atGate")] }), MASTER, say("standing.act.judgeCriteria")),
  g("RELEASE_RUNTIME_UNROUTED", "blocker", say("standing.gate.title.unreadable"), say("standing.gate.unreadable"), ADMIN, say("standing.act.productionReadable")),
  g("RELEASE_CHECK_UNEVALUATED", "blocker", say("standing.gate.title.unevaluated"), say("standing.gate.unevaluated", { check: "serving" }), GATE, say("standing.act.checkCouldNotRun")),
  g("RELEASE_RUNNER_PREFERENCE_UNMET", "warning", say("standing.gate.title.preference"), say("standing.gate.preference"), ADMIN, say("standing.act.labelRunner")),
  g("RELEASE_CRITERIA_HELD_BACK", "warning", say("standing.gate.title.heldBack"), say("standing.gate.heldBack", { owes: [owes("ISS-4", "1")], they: "It is", their: "its" }), MASTER, say("standing.act.judgeCriteria")),
  g("RELEASE_CRITERIA_HELD_BACK", "warning", say("standing.gate.title.heldBack"), say("standing.gate.heldBack", { owes: [owes("ISS-4", "1, 2"), owes("ISS-5", "3")], they: "They are", their: "their" }), MASTER, say("standing.act.judgeCriteria")),
  g("RELEASE_CRITERIA_UNCORROBORATED", "warning", say("standing.gate.title.uncorroborated"), say("standing.gate.uncorroborated", { subject: keys("ISS-4, ISS-5"), verb: "carry" }), GATE, say("standing.act.verdictsNotReread")),
  g("RELEASE_CRITERIA_UNCORROBORATED", "warning", say("standing.gate.title.uncorroborated"), say("standing.gate.uncorroborated", { subject: say("standing.gate.subject.some"), verb: "carry" }), GATE, say("standing.act.verdictsNotReread")),
];

/** A gate reading as core sends it: its English beside what it said. */
export const gateOf = (x: GateSaid, ownerKind?: string) =>
  gateView({ code: x.code, kind: x.kind, title: x.title, sentence: x.sentence, detail: "x", issues: [], owner: { kind: ownerKind ?? (x.who === GATE ? "system" : x.who === MASTER ? "agent" : "person"), who: x.who, act: x.act } });

/** Core's risk sentences as `release-batch/landing-surfaces.ts` says them. */
const risk = (r: string, ref: string, s: Said) => ({ risk: r, ref, sentence: sentence(s), says: { sentence: s } });
export const RISK_SENTENCES = [
  risk("data_removed", "orders.note", say("standing.risk.dataRemoved", { ref: "orders.note" })),
  risk("data_changed", "orders.total", say("standing.risk.dataChanged", { ref: "orders.total" })),
  risk("api_removed", "GET /v1/orders", say("standing.risk.apiRemoved", { ref: "GET /v1/orders" })),
];

const gates = () => (
  <>
    <ul>
      {GATE_SENTENCES.map((x) => {
        const gate = gateOf(x);
        return <GateLine key={`${gate.code}:${gate.sentence}`} slug="hop" gate={gate as never} />;
      })}
    </ul>
    <WhatChanges
      slug="hop"
      changes={{ surfaces: [], risks: RISK_SENTENCES.map((r) => ({ ...r, surface: "data", issues: ["ISS-4"] })), unclassified: [], boxRead: [], shipsNothing: false } as never}
    />
  </>
);

export const SCREENS: ShellScreen[] = [
  { name: "Decisions tab", render: decisions },
  { name: "Mockups tab", render: mockups },
  { name: "Shared badges", render: badges },
  { name: "Release gates and risks", render: gates },
];

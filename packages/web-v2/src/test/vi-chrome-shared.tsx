import { EnumBadge, StatusBadge } from "@/design";
import { DecisionsPanel } from "@/features/comments/components/decisions-panel";
import { MockupsPanel } from "@/features/mockups/components/mockups-panel";
import { GateLine } from "@/features/releases/components/release-bits";
import { WhatChanges } from "@/features/releases/components/release-changes";
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

/** Core's gate readings as `release-batch/release-gates.ts` writes them, one per reading shape. */
export const GATE_SENTENCES: Array<{ code: string; kind: "blocker" | "warning"; title: string; sentence: string; act: string; who: string }> = [
  { code: "NO_RELEASE_GATE", kind: "blocker", title: "No release step", sentence: "This project ships when an issue closes, so there is no release to cut.", who: "A project admin", act: "declare a production environment" },
  { code: "RELEASE_TARGET_UNDECLARED", kind: "blocker", title: "Nowhere to land", sentence: "Nothing says where this project’s releases land. An admin completes its production environment in the project document.", who: "A project admin", act: "declare where releases land" },
  { code: "CLAIM_CONFLICT", kind: "blocker", title: "Issues already claimed", sentence: "ISS-1, ISS-2 are not at the release gate, or another release already holds them. Pick the issues that are waiting.", who: "A project admin", act: "cut the issues that are waiting" },
  { code: "CLAIM_CONFLICT", kind: "blocker", title: "Issues already claimed", sentence: "ISS-1 is not at the release gate, or another release already holds it. Pick the issues that are waiting.", who: "A project admin", act: "cut the issues that are waiting" },
  { code: "RELEASE_ROSTER_EMPTY", kind: "blocker", title: "Nothing at the gate", sentence: "No issue is waiting at the release gate. 2 issues stand one step short of it, at their test step.", who: "Master", act: "bring an issue to the release gate" },
  { code: "RELEASE_ROSTER_EMPTY", kind: "blocker", title: "Nothing at the gate", sentence: "No issue is waiting at the release gate. 1 issue stands one step short of it, at its test step.", who: "Master", act: "bring an issue to the release gate" },
  { code: "RELEASE_ROSTER_EMPTY", kind: "blocker", title: "Nothing at the gate", sentence: "No issue is waiting at the release gate, so there is nothing to cut.", who: "Master", act: "bring an issue to the release gate" },
  { code: "RELEASE_ROSTER_OVERSIZE", kind: "blocker", title: "Too many issues", sentence: "63 issues are waiting, and one release carries at most 50. Split them into smaller releases, oldest merge first.", who: "A project admin", act: "split this release into smaller releases" },
  { code: "RELEASE_ROSTER_OVERSIZE", kind: "blocker", title: "Too many issues", sentence: "More issues are waiting, and one release carries at most 50. Split them into smaller releases, oldest merge first.", who: "A project admin", act: "split this release into smaller releases" },
  { code: "RELEASE_RECORD_MISSING", kind: "blocker", title: "Release note missing", sentence: "ISS-6, ISS-7, ISS-8, ISS-9, ISS-10 and 2 more have no release note, so the release would claim a ship nobody described.", who: "Master", act: "write the release note on ISS-6, ISS-7, ISS-8, ISS-9, ISS-10 and 2 more" },
  { code: "RELEASE_RECORD_MISSING", kind: "blocker", title: "Release note missing", sentence: "ISS-6 has no release note, so the release would claim a ship nobody described.", who: "Master", act: "write the release note on ISS-6" },
  { code: "RELEASE_WORK_UNMERGED", kind: "blocker", title: "Work not marked merged", sentence: "3 issues have no merge Forge saw land, so nothing says their work is in this release.", who: "Master", act: "mark the merge on 3 issues" },
  { code: "RELEASE_WORK_UNMERGED", kind: "blocker", title: "Work not marked merged", sentence: "ISS-6 has no merge Forge saw land, so nothing says its work is in this release.", who: "Master", act: "mark the merge on ISS-6" },
  { code: "RELEASE_PROBES_UNREADABLE", kind: "blocker", title: "Production cannot be proved", sentence: "Production declares no probe that identifies the source commit, so a release there could never be proved. An admin adds one to the production environment.", who: "A project admin", act: "declare a source probe on production" },
  { code: "RELEASE_POOL_EMPTY", kind: "blocker", title: "No runner paired", sentence: "No runner is paired to this project, so no machine can run a release.", who: "A project admin", act: "pair a runner" },
  { code: "NO_RUNNER_ONLINE", kind: "blocker", title: "No runner can take it", sentence: "Runners are paired, and none of them can take a release right now.", who: "A project admin", act: "bring a runner online" },
  { code: "BATCH_IN_FLIGHT", kind: "blocker", title: "A release is running", sentence: "Another release is already running for this project. Let it finish before cutting another.", who: "Release gate", act: "a release is running" },
  { code: "RELEASE_CRITERIA_UNEARNED", kind: "blocker", title: "Criteria still owed", sentence: "ISS-4 owes criteria 1, 2; ISS-5 owes criterion 3. The unattended sweep carries an issue only when every criterion holds a passing verdict.", who: "Master", act: "judge the criteria still owed" },
  { code: "RELEASE_CRITERIA_UNEARNED", kind: "blocker", title: "Criteria still owed", sentence: "Issues at the gate. The unattended sweep carries an issue only when every criterion holds a passing verdict.", who: "Master", act: "judge the criteria still owed" },
  { code: "RELEASE_RUNTIME_UNROUTED", kind: "blocker", title: "Production cannot be read", sentence: "Nothing can read what production serves, so no verdict can earn an issue its place in an unattended release.", who: "A project admin", act: "give production a way to be read" },
  { code: "RELEASE_CHECK_UNEVALUATED", kind: "blocker", title: "A check could not run", sentence: "The serving check could not run, so this list may be missing a reason.", who: "Release gate", act: "a check could not run" },
  { code: "RELEASE_RUNNER_PREFERENCE_UNMET", kind: "warning", title: "Preferred runner missing", sentence: "No runner carries the release label this project asks for, so the release goes to the pool it has.", who: "A project admin", act: "label a runner for releases" },
  { code: "RELEASE_CRITERIA_HELD_BACK", kind: "warning", title: "Some issues held back", sentence: "ISS-4 owes criterion 1. It is held back until its criteria are earned; the others ship.", who: "Master", act: "judge the criteria still owed" },
  { code: "RELEASE_CRITERIA_HELD_BACK", kind: "warning", title: "Some issues held back", sentence: "ISS-4 owes criteria 1, 2; ISS-5 owes criterion 3. They are held back until their criteria are earned; the others ship.", who: "Master", act: "judge the criteria still owed" },
  { code: "RELEASE_CRITERIA_UNCORROBORATED", kind: "warning", title: "Verdicts not re-read", sentence: "ISS-4, ISS-5 carry a verdict earned where nothing could re-read production. It counts, and it is weaker evidence.", who: "Release gate", act: "verdicts not re-read" },
  { code: "RELEASE_CRITERIA_UNCORROBORATED", kind: "warning", title: "Verdicts not re-read", sentence: "Some issues carry a verdict earned where nothing could re-read production. It counts, and it is weaker evidence.", who: "Release gate", act: "verdicts not re-read" },
];

/** Core's risk sentences as `release-batch/landing-surfaces.ts` writes them. */
export const RISK_SENTENCES = [
  { risk: "data_removed", ref: "orders.note", sentence: "orders.note is removed: data it held does not come back with a rollback" },
  { risk: "data_changed", ref: "orders.total", sentence: "orders.total changes shape: rows written before it are read by the new shape" },
  { risk: "api_removed", ref: "GET /v1/orders", sentence: "GET /v1/orders is removed: a caller still using it is refused after this ships" },
];

const gates = () => (
  <>
    <ul>
      {GATE_SENTENCES.map((g) => (
        <GateLine
          key={`${g.code}:${g.sentence}`}
          slug="hop"
          gate={{ code: g.code, kind: g.kind, title: g.title, sentence: g.sentence, detail: "x", issues: [], owner: { kind: g.who === "Release gate" ? "system" : g.who === "Master" ? "agent" : "person", who: g.who, act: g.act } } as never}
        />
      ))}
    </ul>
    <WhatChanges
      slug="hop"
      changes={{ surfaces: [], risks: RISK_SENTENCES.map((r) => ({ ...r, surface: "data", issues: ["ISS-4"] })), unclassified: [], boxRead: [], shipsNothing: false } as never}
    />
  </>
);

export const SHARED_SCREENS: ShellScreen[] = [
  { name: "Decisions tab", render: decisions },
  { name: "Mockups tab", render: mockups },
  { name: "Shared badges", render: badges },
  { name: "Release gates and risks", render: gates },
];

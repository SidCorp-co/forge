import type { Said } from "@forge/contracts/said";
import { gateView, RULE, say, verbatim, waitingOn } from "./said";
import type { QueryKey } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { ComingNext } from "@/features/releases/components/coming-next";
import { ReleaseActions } from "@/features/releases/components/release-actions";
import { ReleaseItemScreen } from "@/features/releases/components/release-item-screen";
import { ChecksPane } from "@/features/releases/components/release-checks";
import { WhatChanges } from "@/features/releases/components/release-changes";
import { CriteriaPane, IssuesPane, NotesPane } from "@/features/releases/components/release-panes";
import { ReleasePeek } from "@/features/releases/components/release-peek";
import { ReleasesScreen } from "@/features/releases/components/releases-screen";
import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { HealthBar, Legend, SearchBox, ViewBar, WalkBar, ZoomBar } from "@/features/workflows/canvas/controls";
import { useWorkflowTemplates } from "@/features/workflows/hooks";
import { TypeChip } from "@/features/workflows/canvas/nodes";
import { type Canvas, readCanvas } from "@/features/workflows/canvas/model";
import { DetailPanel } from "@/features/workflows/canvas/panel";
import { SystemOverviewRegion } from "@/features/workflows/components/system-overview";
import { OrphanedTraces } from "@/features/workflows/components/design-decision";
import { WorkflowDesignFacts } from "@/features/workflows/components/workflow-design-facts";
import { WorkflowDesignPage } from "@/features/workflows/components/workflow-design-page";
import { WorkflowDesignScreen } from "@/features/workflows/components/workflow-design-screen";
import { WorkflowsScreen } from "@/features/workflows/components/workflows-screen";
import { productCopy } from "@/lib/i18n/product-copy";
import { Seeded } from "./vi-chrome-requirements";

// The Releases and Workflows screens the vi walking test renders, each filled from a query cache
// seeded with data that carries no English word of its own: core's act texts are ones standing-copy
// reads, and everything a person or an agent wrote is placeholder words.

const P = "p1";
const AT = "2026-10-07T10:00:00Z";
const nobody = waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE });
const you = (act: Said) => waitingOn("you", { who: say("standing.who.you"), act, rule: RULE });
const CUT = say("standing.act.cut", { v: "0.1.0", more: null });
const lan = { id: "u1", name: "Lan", kind: "human" };

const contents = [{ requirement: { key: "REQ-1", title: "Muc" }, issues: [{ key: "ISS-1", title: "Muc", proof: "proven" }] }, { requirement: null, issues: [{ key: "ISS-2", title: "Muc", proof: "open" }] }];

const summary = (over: Record<string, unknown>) => ({
  key: "0.1.0",
  version: "0.1.0",
  runId: null,
  state: "draft",
  current: false,
  headline: "",
  issueCount: 2,
  requirements: [],
  criteria: { total: 2, proven: 1, failing: 0, open: 1 },
  verified: { level: "some_criteria", proven: 1, total: 2, check: null },
  contents,
  owner: null,
  ownerAct: null,
  can: { cut: true, decide: false, split: false },
  split: null,
  openedAt: null,
  releasedAt: null,
  at: AT,
  attentionGroup: "needs_you",
  waitingOn: you(CUT),
  ...over,
});

const draft = summary({
  waitingOn: waitingOn("you", {
    who: say("standing.who.you"),
    act: say("standing.act.splitRelease"),
    rule: RULE,
    effect: say("releases.effect.split", { limit: 50, left: say("releases.effect.splitRest", { n: 13 }) }),
  }),
});
const shipped = summary({ key: "0.0.9", version: "0.0.9", state: "shipped", current: true, attentionGroup: "done", waitingOn: nobody, requirements: ["REQ-1"], criteria: { total: 0, proven: 0, failing: 0, open: 0 }, owner: lan, ownerAct: "Cut", openedAt: AT, releasedAt: AT });

const detail = {
  ...draft,
  feedbackAnswered: [
    { key: "FB-1", title: "Muc", reporter: "Lan", agency: "human", told: "on_ship", toldAt: null },
    { key: "FB-2", title: "Muc", reporter: "Minh", agency: "agent", told: "not_told", toldAt: null },
  ],
  issues: [
    { id: "i1", key: "ISS-1", title: "Muc", status: "awaiting_release", section: null, requirement: "REQ-1", proof: "proven", criteria: { total: 1, proven: 1, failing: 0, open: 0 }, waitingOn: you(CUT), surfaces: ["ui"], landing: { kind: "named", artifacts: [], unmappedPaths: [], unread: null, source: "box" }, unclassified: false },
    { id: "i2", key: "ISS-2", title: "Muc", status: "awaiting_release", section: null, requirement: null, proof: "unrecorded", criteria: { total: 0, proven: 0, failing: 0, open: 0 }, waitingOn: you(CUT), surfaces: [], landing: { kind: "unclassified", why: "ly do", paths: [], source: null }, unclassified: true },
  ],
  requirementsCompleted: [{ key: "REQ-1", title: "Muc", state: "in_delivery", completes: false, advances: [{ code: "BC-1", verdict: "passing" }], remaining: { issues: ["ISS-2"], criteria: ["BC-2"] } }],
  issueCriteria: [{ key: "ISS-1", title: "Muc", criteria: [{ n: 1, statement: "Dieu kien", standing: "pass", bc: "BC-1", identity: null, reason: null, judgedAt: AT, judgedBy: "agent" }] }],
  changes: {
    surfaces: [
      { surface: "ui", count: 2, shipsNothing: false, issues: ["ISS-1"], artifacts: [{ ref: "screen:/a", change: "added", issues: ["ISS-1"], carriedBy: null }] },
      { surface: "api", count: 1, shipsNothing: false, issues: ["ISS-1"], artifacts: [] },
      { surface: "design", count: 1, shipsNothing: true, issues: ["ISS-1"], artifacts: [] },
    ],
    risks: [],
    unclassified: [{ key: "ISS-2", why: "ly do", paths: [] }],
    boxRead: ["ISS-1"],
    shipsNothing: false,
  },
  notes: {
    designs: [],
    sections: [{ section: "Muc moi", entries: [{ key: "ISS-1", title: "Muc", userFacing: "Noi dung", technical: "ky thuat" }] }],
    withoutNotes: [{ key: "ISS-2", title: "Muc" }, { key: "ISS-3", title: "Muc" }],
    language: "vi",
    attention: [{ key: "ISS-1", title: "Muc", notInLanguage: true, references: ["src/a.ts"] }],
  },
  gates: [
    gateView({
      code: "RELEASE_ROSTER_OVERSIZE",
      kind: "blocker",
      title: verbatim("Cong A"),
      sentence: verbatim("Noi dung"),
      detail: "chi tiet",
      issues: ["ISS-1", "ISS-2", "ISS-3", "ISS-4", "ISS-5", "ISS-6"],
      owner: { kind: "person", who: say("standing.who.holderOf", { perm: "project.admin" }), act: say("standing.act.cutWaiting") },
    }),
  ],
  approval: { id: "a1", requestedBy: lan, requestedAt: AT, evidence: { environment: "prod", commit: "abcdef123", reading: "doc" }, note: null, decision: null, decidedBy: null, decidedAt: null, reason: null },
  approvals: [{ id: "a0", requestedBy: lan, requestedAt: AT, evidence: { environment: "prod", commit: "abcdef123", reading: "doc" }, note: null, decision: "returned", decidedBy: lan, decidedAt: AT, reason: "ly do" }],
  approvers: [],
  approvalRequired: true,
  attempts: [
    { id: "t1", stage: "deploy", verdict: "ok", health: "up", commit: "abcdef123", providerRef: null, identity: null, readings: ["doc"], verdictReason: null, account: null, startedAt: AT, settledAt: AT },
    { id: "t2", stage: "verify", verdict: "unverified", health: "down", commit: null, providerRef: null, identity: null, readings: [], verdictReason: null, account: null, startedAt: AT, settledAt: null },
  ],
  production: { name: null, url: "https://a.vn" },
  head: null,
};

const stamp = { label: "forecast" as const, asOf: AT };
const coming = {
  ...stamp,
  projectId: P,
  requirements: [{ ...stamp, scope: "requirement", key: "REQ-1", title: "Muc", progress: { total: 3, shipped: 0, awaitingRelease: 1, toDo: 2 }, forecast: null, next: null, delivery: null }],
  draft: { ...stamp, scope: "release", key: "draft", title: null, progress: { total: 2, shipped: 0, awaitingRelease: 1, toDo: 1 }, forecast: null, next: null, delivery: null },
};

const releaseSeed = (): [QueryKey, unknown][] => [
  [["releases", P], { releases: [draft, shipped], counts: {}, approvalRequired: true, production: { ok: false, reason: "r" } }],
  [["issues", "standing", "forecast", "coming-next", P], coming],
  [["release", P, "0.1.0"], { release: detail }],
];

const peek = { open: "0.1.0", position: { at: 1, of: 2 }, set: () => {}, move: () => {} };

export const releasesScreen = (): ReactElement => (
  <Seeded data={releaseSeed()}>
    <ReleasesScreen projectId={P} slug="hop" />
    <ComingNext next={coming as never} draft={summary({ waitingOn: waitingOn("person", { who: say("standing.who.holderOf", { perm: "releases.approve" }), act: CUT, rule: RULE }) }) as never} slug="hop" clock={{ lang: "vi", now: Date.parse(AT) }} />
    <ReleasePeek projectId={P} version="0.1.0" peek={peek} onOpenFull={() => {}} />
  </Seeded>
);

export const releaseDetailScreen = (): ReactElement => (
  <Seeded data={releaseSeed()}>
    <ReleaseItemScreen projectId={P} slug="hop" version="0.1.0" />
    <ReleaseActions projectId={P} r={{ ...detail, can: { cut: false, decide: false, split: true }, split: { issueIds: ["i1"], rest: 13 } } as never} />
    <IssuesPane r={detail as never} slug="hop" />
    <CriteriaPane r={detail as never} />
    <ChecksPane r={detail as never} />
    <NotesPane r={detail as never} slug="hop" />
    <WhatChanges changes={detail.changes as never} slug="hop" />
    <ChecksPane r={{ ...detail, attempts: [], approvals: [] } as never} />
    <NotesPane r={{ ...detail, notes: { ...detail.notes, sections: [], withoutNotes: [] } } as never} slug="hop" />
  </Seeded>
);

const health = { counts: { outdated: 1, needs_update: 0, has_problem: 0, remove_proposed: 0, upcoming: 0, not_in_design: 0, wrong: 0 }, needsYou: 1, workflowLevelOnly: false, observed: true, reconciled: false };
const step = (id: string, after: string[] = [], node?: Record<string, unknown>) => ({ id, title: `Buoc ${id}`, does: "Lam", after, ...(node ? { node } : {}) });
const body = (flow: string, over: Record<string, unknown> = {}) => ({
  version: 1,
  project: "hop",
  flow,
  kind: "flow",
  title: `Luong ${flow}`,
  summary: "Tom tat",
  steps: [step("a", [], { type: "STEP", owner: "Lan", sla: "2 ngay", conditions: [{ when: "khi", result: "ket qua" }] }), step("b", ["a"]), step("c", ["b"])],
  writtenBy: {},
  ...over,
});
const record = (flow: string, status: string, pending: number | null, over: Record<string, unknown> = {}) => ({
  revision: 2,
  writer: "u1",
  writerName: "Lan",
  design: { shown: status, status, pendingRevision: pending, approvedRevision: 1, returnReason: null, waitingOn: nobody },
  document: { ...body(flow, over), id: `w-${flow}`, createdAt: AT, updatedAt: AT },
  health,
});
const records = [record("dat-hang", "approved", 2), record("vong-doi", "proposed", null, { kind: "state" }), record("tich-hop", "returned", null, { version: 2, template: { id: "integration-sequence", version: 1 } })];
const workflowSeed = (): [QueryKey, unknown][] => [
  [["workflows", P], { workflows: records, returned: records.length }],
  [["workflow-templates", P], { templates: BUILTIN_WORKFLOW_TEMPLATES.map((template) => ({ origin: "builtin", template })), returned: BUILTIN_WORKFLOW_TEMPLATES.length }],
];

export const workflowsScreen = (): ReactElement => (
  <Seeded data={workflowSeed()}>
    <WorkflowsScreen projectId={P} slug="hop" projectName="Hop" canEdit />
  </Seeded>
);

const contextRecord = record("he-thong", "approved", null, { version: 2, template: { id: "system-context", version: 1 } });
const graph = { facts: { people: [{ name: "Khach", count: 2, unconfirmed: 1 }], externals: 3, namedBoundaries: 2, boundaries: [{ name: "Ngan hang", count: 2 }] }, focal: null, nodes: [] };

export const systemOverviewScreen = (): ReactElement => (
  <Seeded data={[[["system-graph", P, "w-he-thong", 2, 0], graph]]}>
    <SystemOverviewRegion records={[contextRecord, ...records] as never} templates={[]} projectId={P} slug="hop" projectName="Hop" />
    <SystemOverviewRegion records={[contextRecord] as never} templates={[]} projectId={P} slug="hop" projectName="Hop" variant="compact" />
  </Seeded>
);

const workflowHealth = {
  workflowId: "w-dat-hang",
  flow: "dat-hang",
  revision: 2,
  approvedRevision: 1,
  proposedRevision: 2,
  proposal: null,
  rooted: { rooted: true, approvedRevision: 1, requirements: ["REQ-1"], missing: [] },
  observation: { id: "o", atSha: "abcdef123", revision: 1, createdAt: AT, writtenBy: "u", writtenByAgency: "agent" },
  markers: [{ kind: "outdated", target: { kind: "workflow" }, rule: "x", reason: "ly do", source: { type: "issue", key: "ISS-1", href: null }, waitingOn: nobody, since: null }],
  counts: health.counts,
  nodes: [],
  workflowLevel: [],
  needsYou: 1,
  orphanedTraces: [{ recordType: "feedback", key: "FB-1", href: null, target: { kind: "step", step: "b" } }],
  diff: null,
  observed: null,
  reconciliation: { state: "reconciled", undecided: 0, cleaning: 0, issues: ["ISS-1"], version: { version: "0.1.0", releasedAt: AT }, criteria: { total: 2, proven: 1 }, rule: "da khop", says: { rule: verbatim("da khop") } },
};
const design = {
  workflowId: "w-dat-hang",
  flow: "dat-hang",
  status: "proposed",
  revision: 2,
  proposedRevision: 2,
  approvedRevision: 1,
  approver: "workflow-designs.approve",
  canDecide: true,
  waitingOn: you(say("standing.act.approveDesign", { what: "Luong" })),
  revisions: [
    { revision: 2, document: body("dat-hang"), proposedBy: "u1", proposedByName: "Lan", proposedAt: AT, decision: null, decidedBy: null, decidedByName: null, decidedAt: null, reason: null, state: "proposed", changes: { steps: { added: ["Buoc d"], removed: [], changed: ["Buoc a"] }, edges: { added: 1, removed: 0, changed: 2 } } },
    { revision: 1, document: body("dat-hang"), proposedBy: "u1", proposedByName: "Lan", proposedAt: AT, decision: "approve", decidedBy: "u2", decidedByName: "Minh", decidedAt: AT, reason: "ghi chu", state: "current", changes: null },
  ],
  builds: [{ issueId: "i1", displayId: "ISS-1", title: "Muc", status: "in_progress", builtAgainst: 1 }],
  gate: { open: false, rule: "giu", says: { rule: verbatim("giu") } },
  requirements: [{ key: "REQ-1", title: "Muc", status: "agreed", state: "in_delivery", pinnedRevision: 1 }],
};
const designSeed = (): [QueryKey, unknown][] => [
  ...workflowSeed(),
  [["workflow-design", P, "w-dat-hang"], design],
  [["workflow-health", P, "w-dat-hang"], workflowHealth],
];
const designRecord = records[0];

export const workflowDesignScreen = (): ReactElement => (
  <Seeded data={designSeed()}>
    <WorkflowDesignScreen projectId={P} slug="hop" flow="dat-hang" />
    {(["steps", "revisions"] as const).map((tab) => (
      <WorkflowDesignPage key={tab} projectId={P} slug="hop" d={design as never} record={designRecord as never} template={null} tab={tab} onTab={() => {}} />
    ))}
    <WorkflowDesignFacts d={{ ...design, gate: { open: true, rule: "mo", says: { rule: verbatim("mo") } } } as never} record={designRecord as never} shown={body("dat-hang", { kind: "state" }) as never} shownRevision={2} template={null} slug="hop" health={{ ...workflowHealth, rooted: { rooted: false, missing: ["approved_revision", "requirement"] }, observation: null } as never} />
    <OrphanedTraces traces={[{ recordType: "requirement_criterion", key: "REQ-1", href: null, target: { kind: "edge", from: "a", to: "b", label: null } }] as never} revision={2} />
  </Seeded>
);

const canvas: Canvas = readCanvas(body("dat-hang") as never, null, productCopy("vi"));
const overlay = { on: true, onToggle: () => {}, layer: "both", onLayer: () => {}, observed: true, nodes: new Map(), edges: new Map(), hrefOf: () => null } as never;

/** Every built-in template as the canvas draws it: its title, its legend (node types and line kinds), each node type's chip and its bands. */
function BuiltinTemplates() {
  const templates = useWorkflowTemplates(P).data?.templates ?? [];
  return (
    <>
      {templates.map(({ template }) => (
        <section key={template.id} title={template.title}>
          <Legend template={template} />
          {template.nodeTypes.map((n) => (
            <TypeChip key={n.id} type={n} />
          ))}
          {(template.lanes.from === "template" ? template.lanes.bands : []).map((b) => (
            <span key={b.id} title={b.tooltip}>
              {b.label}
            </span>
          ))}
        </section>
      ))}
    </>
  );
}

export const workflowCanvasScreen = (): ReactElement => (
  <Seeded data={workflowSeed()}>
    <BuiltinTemplates />
    <ViewBar language="business" lod={1} banded allOpen={false} onLanguage={() => {}} onLod={() => {}} onToggleAll={() => {}} onWalk={() => {}} health={overlay} />
    <HealthBar health={overlay} />
    <SearchBox c={canvas} hits={[]} query="x" onQuery={() => {}} onPick={() => {}} />
    <ZoomBar zoom={1} minimap legend onZoom={() => {}} onReset={() => {}} onFit={() => {}} onMinimap={() => {}} onLegend={() => {}} />
    <WalkBar at={0} total={3} onWalk={() => {}} onStop={() => {}} />
    <DetailPanel canvas={canvas} selection={{ step: "a" }} walk={null} decision={null} onClose={() => {}} onWalk={() => {}} onStep={() => {}} onEdge={() => {}} />
    <DetailPanel canvas={canvas} selection={{ step: "b" }} walk={{ order: ["a", "b", "c"], at: 1 }} decision={null} onClose={() => {}} onWalk={() => {}} onStep={() => {}} onEdge={() => {}} />
    <DetailPanel canvas={canvas} selection={null} walk={{ order: ["a", "b", "c"], at: 3 }} decision={null} onClose={() => {}} onWalk={() => {}} onStep={() => {}} onEdge={() => {}} />
    <DetailPanel canvas={canvas} selection={{ edge: "a>b" }} walk={null} decision={null} onClose={() => {}} onWalk={() => {}} onStep={() => {}} onEdge={() => {}} />
  </Seeded>
);

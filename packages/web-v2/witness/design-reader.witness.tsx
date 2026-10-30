// One design as a first-time reader opens it (ISS-781 part 1, REQ-10 BC-15, BC-16; REQ-43 BC-1,
// BC-4, BC-5): agenfold's workspace-onboarding draft as the owner met it on dev.373, which opened on
// stage chips that hid what each step does, under three stacked layers of controls, a rail of
// sentences and the draft's state said four times. Witnessed at 1440 x 900 and 390 x 844: every
// stage open and every step a full card, no two cards overlapping; a toolbar of one row starting with
// Walk through and holding no view-mode switch; Where it stands as three marks; the state said once
// and the actor it waits on named as the list names it.
//
//   pnpm --filter web-v2 witness witness/design-reader.witness.tsx --out <dir>

import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { WorkflowDesignScreen } from "@/features/workflows/components/workflow-design-screen";
import { RULE, say, waitingOn } from "@/test/said";
import "./entry";
import { InRouter } from "./router";

const P = "p-agenfold";
const W = "w-workspace-onboarding";
const AT = "2026-10-30T04:00:00.000Z";
const draft = waitingOn("agent", { who: say("standing.who.named", { name: "orchestrator" }), act: say("designs.act.finish"), rule: RULE });
const zero = { outdated: 0, needs_update: 0, has_problem: 0, remove_proposed: 0, upcoming: 0, not_in_design: 0, wrong: 0 };

const step = (id: string, type: string, label: string, does: string, after: string[], more: Record<string, unknown> = {}) => ({ id, does, after, node: { type, label, purpose: does, ...more } });
const STEPS = [
  step("owner", "SOURCE", "Owner", "Owner initiates onboarding.", [], { owner: "Workspace owner" }),
  step("requested", "EVENT", "Workspace requested", "Submit request with owner and tenant details.", ["owner"]),
  step("policy", "RULE", "Access policy", "Apply workspace ownership and least-privilege policy.", ["requested"], {
    conditions: [{ when: "owner has workspace create permission", result: "allow; otherwise deny" }],
  }),
  step("case", "CASE", "Onboarding case", "Track setup request and decisions.", ["policy"], { owner: "Workspace owner" }),
  step("provision", "TASK", "Provision workspace", "Provision tenant, member roles and resource bindings.", ["case"], { owner: "Workspace admin", sla: "24h" }),
  step("grant", "ACTION", "Grant capabilities", "Apply scoped grants and audit them.", ["provision"], { owner: "Workspace admin" }),
  step("ready", "OUTCOME", "Workspace ready", "The workspace is ready with its grants recorded.", ["grant"]),
];
const DOCUMENT = {
  version: 2,
  project: P,
  flow: "workspace-onboarding",
  kind: "flow",
  title: "Workspace onboarding and resource grants",
  summary: "Isolated workspace setup, scoped memberships, resource registration and explicit operator grants.",
  template: { id: "operational-flow", version: 1 },
  steps: STEPS,
  edges: [
    { from: "owner", to: "requested", label: "emits" },
    { from: "requested", to: "policy", label: "evaluates" },
    { from: "policy", to: "case", label: "opens" },
    { from: "case", to: "provision", label: "performs" },
    { from: "provision", to: "grant", label: "performs" },
    { from: "grant", to: "ready", label: "results in" },
  ],
  writtenBy: {},
  id: W,
  createdAt: AT,
  updatedAt: AT,
};
const RECORD = {
  workflowId: W,
  revision: 1,
  writer: "u-orchestrator",
  writerName: "orchestrator",
  requirements: [],
  design: { shown: "draft", status: "draft", pendingRevision: null, approvedRevision: null, returnReason: null, waitingOn: draft },
  document: DOCUMENT,
  health: { counts: zero, needsYou: 0, workflowLevelOnly: false, observed: false, reconciled: false },
};
const HELD = say("designs.gate.held", { why: say("designs.gate.status", { status: "draft" }) });
const DESIGN = {
  workflowId: W,
  flow: "workspace-onboarding",
  status: "draft",
  revision: 1,
  proposedRevision: null,
  approvedRevision: null,
  approver: "workflow-designs.approve",
  canDecide: false,
  waitingOn: draft,
  revisions: [],
  builds: [],
  gate: { open: false, rule: "held", says: { rule: HELD } },
  requirements: [],
  approvalBlocked: null,
  approvalLeavesStale: [],
  pinOnly: null,
};
const HEALTH = {
  workflowId: W,
  flow: "workspace-onboarding",
  revision: 1,
  rooted: { rooted: false, approvedRevision: null, requirements: [], missing: ["approved_revision", "requirement"] },
  observation: null,
  markers: [],
  counts: zero,
  needsYou: 0,
  nodes: [],
  orphanedTraces: [],
  diff: null,
  reconciliation: { state: "open", undecided: 0, cleaning: 0, issues: [], version: null, criteria: { total: 0, proven: 0 }, rule: "unobserved", says: { rule: say("workflows.reconcile.unobserved") } },
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.localStorage.clear();
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname;
  if (path.endsWith(`/projects/${P}/workflows`)) return json({ workflows: [RECORD], returned: 1 });
  if (path.endsWith(`/projects/${P}/workflow-templates`)) return json({ templates: BUILTIN_WORKFLOW_TEMPLATES.map((template) => ({ origin: "builtin", template })), returned: BUILTIN_WORKFLOW_TEMPLATES.length });
  if (path.endsWith(`/workflows/${W}/design`)) return json(DESIGN);
  if (path.endsWith(`/workflows/${W}/health`)) return json({ health: HEALTH });
  return new Promise<Response>(() => {});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const phone = window.innerWidth < 768;
const noop = () => {};

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/agenfold/workflows/workspace-onboarding" pattern="/projects/$slug/workflows/$flow">
    <QueryClientProvider client={client}>
      <TopBarSlotProvider>
        <div className="flex h-dvh overflow-hidden bg-shell" data-shell>
          {phone ? null : <div className="h-full flex-none border-r border-line bg-surface" style={{ width: 88 }} />}
          <div className="flex min-w-0 flex-1 flex-col" data-page>
            <ShellTopBar chatOpen={false} onToggleChat={noop} />
            <main className="min-h-0 flex-1 overflow-y-auto bg-app" data-witness="main">
              <WorkflowDesignScreen projectId={P} slug="agenfold" flow="workspace-onboarding" />
            </main>
          </div>
        </div>
      </TopBarSlotProvider>
    </QueryClientProvider>
  </InRouter>,
);

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const text = (el: Element | null) => (el as HTMLElement | null)?.innerText.replace(/\s+/g, " ").trim() ?? "";
const stepCards = () => [...document.querySelectorAll<HTMLElement>(".react-flow__node-step")];

function opensReadable(): string[] {
  const wrong: string[] = [];
  const folded = document.querySelectorAll(".react-flow__node-band").length;
  if (folded) wrong.push(`C5: ${folded} stages open folded into chips`);
  const cards = stepCards();
  if (cards.length !== STEPS.length) wrong.push(`C5: ${cards.length} step cards are drawn, not ${STEPS.length}`);
  for (const s of STEPS) {
    const card = cards.find((c) => c.innerText.includes(s.node.label));
    if (!card) continue;
    if (!card.innerText.includes(s.does)) wrong.push(`C5: "${s.node.label}" does not say what it does`);
    const owner = (s.node as { owner?: string }).owner;
    if (owner && !card.innerText.includes(owner)) wrong.push(`C5: "${s.node.label}" does not name its owner ${owner}`);
  }
  const labels = [...document.querySelectorAll(".react-flow__edge-text, .react-flow__edgelabel-renderer > *")].map(text).filter(Boolean);
  if (labels.length < DOCUMENT.edges.length) wrong.push(`C5: ${labels.length} lines say what a step leads to, not ${DOCUMENT.edges.length}`);
  const boxes = cards.map((c) => ({ name: c.innerText.split("\n")[1] ?? c.innerText.slice(0, 20), r: c.getBoundingClientRect() }));
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const overlap = a.r.left < b.r.right - 1 && b.r.left < a.r.right - 1 && a.r.top < b.r.bottom - 1 && b.r.top < a.r.bottom - 1;
      if (overlap) wrong.push(`C5: the "${a.name}" and "${b.name}" cards overlap`);
    }
  }
  return wrong;
}

function oneToolbar(): string[] {
  const wrong: string[] = [];
  const bar = document.querySelector<HTMLElement>("[data-testid=canvas-toolbar]");
  if (!bar) return ["C6: no canvas toolbar"];
  if (bar.firstElementChild?.getAttribute("data-testid") !== "walk-start-bar") wrong.push(`C6: the toolbar starts with "${text(bar.firstElementChild)}", not Walk through`);
  const said = text(bar);
  for (const w of ["Stages", "Steps", "Detail", "Business", "Contract"]) if (said.includes(w)) wrong.push(`C6: the toolbar still offers "${w}"`);
  const walk = bar.querySelector("[data-testid=walk-start-bar]")?.getBoundingClientRect();
  const rows = new Set([...bar.children].map((c) => Math.round(c.getBoundingClientRect().top / 8))).size;
  if (!phone && walk && bar.getBoundingClientRect().height > walk.height + 16) wrong.push(`C6: the toolbar wraps to ${rows} rows (${Math.round(bar.getBoundingClientRect().height)} px tall)`);
  return wrong;
}

function standsAsMarks(): string[] {
  const wrong: string[] = [];
  const rail = document.querySelector("[data-testid=plain-status]");
  if (!rail) return phone ? [] : ["C7: no Where it stands group"];
  const rows = ["stands-approved", "stands-requirement", "stands-code"].map((id) => rail.querySelector(`[data-testid=${id}]`));
  rows.forEach((r, i) => {
    if (!r) wrong.push(`C7: Where it stands has no row ${i + 1}`);
    const value = text(r?.querySelector("[data-stand]") ?? null);
    if (value.split(" ").length > 3) wrong.push(`C7: "${value}" is more than three words`);
  });
  if (/[.]/.test(text(rail))) wrong.push(`C7: Where it stands holds a sentence: "${text(rail)}"`);
  return wrong;
}

function stateOnce(): string[] {
  const wrong: string[] = [];
  const page = text(document.querySelector("[data-testid=workflow-design-screen]"));
  for (const s of ["Not approved yet", "on hold until it is approved", "Waiting on Master"]) if (page.includes(s)) wrong.push(`C8: the page still says "${s}"`);
  const banner = text(document.querySelector("[data-testid=design-banner-line]"));
  if (!banner.includes("orchestrator")) wrong.push(`C8: the banner names "${banner}", not orchestrator as the list does`);
  return wrong;
}

/** REQ-43 BC-3: the words a 1440 x 900 first screen shows. */
function firstScreenWords(): string[] {
  if (phone) return [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let words = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.textContent?.trim()) continue;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth || style.visibility === "hidden" || style.display === "none") continue;
    words += n.textContent.trim().split(/\s+/).length;
  }
  console.log(`FIRST-SCREEN WORDS ${words}`);
  return words > 300 ? [`the first screen shows ${words} words, over 300`] : [];
}

const all = () => [...opensReadable(), ...oneToolbar(), ...standsAsMarks(), ...stateOnce(), ...firstScreenWords()];

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => document.querySelectorAll(".react-flow__node-step, .react-flow__node-band").length > 0 && document.querySelector(".wfc[data-ready=true]") !== null,
  stages: [
    { name: "light", run: async () => (theme("light"), await settle(1200), all()) },
    { name: "dark", run: async () => (theme("dark"), await settle(), all()) },
  ],
};

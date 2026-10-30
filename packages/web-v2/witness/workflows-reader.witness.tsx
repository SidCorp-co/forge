// A project's workflows as a first-time reader opens them (ISS-781 part 1, REQ-10 BC-12..BC-14,
// REQ-43 BC-5): agenfold's four drafts as the owner met them on dev.373, which read alphabetically,
// governed-actions first although it builds on the other three, under a "No context · Ask for
// designs" line, with the same state on every row and the count said twice. Witnessed at 1440 and
// 390 px: the rows in the order they build on each other, each naming its requirement or None, one
// line saying whether the viewer owes anything, the shared state said once, and no "No context".
//
//   pnpm --filter web-v2 witness witness/workflows-reader.witness.tsx --out <dir>

import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BottomTabBar, TopBarSlotProvider } from "@/design";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { bottomTabItems } from "@/features/shell/nav-model";
import { WorkflowsScreen } from "@/features/workflows/components/workflows-screen";
import { RULE, say, waitingOn } from "@/test/said";
import "./entry";
import { InRouter } from "./router";

const P = "p-agenfold";
const AT = "2026-10-30T04:00:00.000Z";
const draft = waitingOn("agent", { who: say("standing.who.named", { name: "orchestrator" }), act: say("designs.act.finish"), rule: RULE });
const zero = { outdated: 0, needs_update: 0, has_problem: 0, remove_proposed: 0, upcoming: 0, not_in_design: 0, wrong: 0 };

const record = (flow: string, title: string, o: { basedOn?: string[]; refs?: string[]; requirements?: string[] } = {}) => ({
  workflowId: `w-${flow}`,
  revision: 1,
  writer: "u-orchestrator",
  writerName: "orchestrator",
  requirements: o.requirements ?? [],
  design: { shown: "draft", status: "draft", pendingRevision: null, approvedRevision: null, returnReason: null, waitingOn: draft },
  document: {
    version: 2,
    project: P,
    flow,
    kind: "flow",
    title,
    summary: "",
    template: { id: "operational-flow", version: 1 },
    steps: Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`,
      title: `Step ${i}`,
      does: "Does",
      after: i ? [`s${i - 1}`] : [],
      node: { type: "EVENT", ...(i === 0 && o.refs ? { refs: o.refs.map((f) => ({ template: "operational-flow", flow: f, step: "s0" })) } : {}) },
    })),
    ...(o.basedOn ? { basedOn: o.basedOn.map((workflow) => ({ workflow, revision: 1 })) } : {}),
    writtenBy: {},
    id: `w-${flow}`,
    createdAt: AT,
    updatedAt: AT,
  },
  health: { counts: zero, needsYou: 0, workflowLevelOnly: false, observed: false, reconciled: false },
});

const RECORDS = [
  record("governed-actions", "Governed business action and approval loop", { basedOn: ["workspace-onboarding", "strategy-planning"], refs: ["operator-lifecycle"] }),
  record("operator-lifecycle", "Operator lifecycle and safe replication", { basedOn: ["workspace-onboarding"] }),
  record("strategy-planning", "Strategy planning, durable execution and outcome review", { refs: ["operator-lifecycle"], requirements: ["REQ-4"] }),
  record("workspace-onboarding", "Workspace onboarding and resource grants", { requirements: ["REQ-2"] }),
];
const ORDER = [
  "Workspace onboarding and resource grants",
  "Operator lifecycle and safe replication",
  "Strategy planning, durable execution and outcome review",
  "Governed business action and approval loop",
];
const KEYS = ["REQ-2", "None", "REQ-4", "None"];

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.localStorage.clear();
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname;
  if (path.endsWith(`/projects/${P}/workflows`)) return json({ workflows: RECORDS, returned: RECORDS.length });
  if (path.endsWith(`/projects/${P}/workflow-templates`)) return json({ templates: BUILTIN_WORKFLOW_TEMPLATES.map((template) => ({ origin: "builtin", template })), returned: BUILTIN_WORKFLOW_TEMPLATES.length });
  return new Promise<Response>(() => {});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const phone = window.innerWidth < 768;
const noop = () => {};

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/agenfold/workflows" pattern="/projects/$slug/workflows">
    <QueryClientProvider client={client}>
      <TopBarSlotProvider>
        <div className="flex h-dvh overflow-hidden bg-shell" data-shell>
          {phone ? null : <div className="h-full flex-none border-r border-line bg-surface" style={{ width: 88 }} />}
          <div className="flex min-w-0 flex-1 flex-col" data-page>
            <ShellTopBar chatOpen={false} onToggleChat={noop} />
            <main className="min-h-0 flex-1 overflow-y-auto bg-app pb-[calc(56px+env(safe-area-inset-bottom))] window-md:pb-0" data-witness="main">
              <div className="flex min-h-full min-w-0 flex-col">
                <WorkflowsScreen projectId={P} slug="agenfold" projectName="Agenfold" />
              </div>
            </main>
          </div>
          <BottomTabBar items={bottomTabItems(4)} activeKey="home" onSelect={noop} />
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

function reader(): string[] {
  const wrong: string[] = [];
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  const rows = [...document.querySelectorAll<HTMLElement>("[data-testid=workflow-row]")];
  const titles = rows.map((r) => ORDER.find((t) => r.innerText.includes(t)) ?? "?");
  if (titles.join("|") !== ORDER.join("|")) wrong.push(`C1: the rows read ${titles.join(" > ")}, not in the order they build on each other`);
  const keys = rows.map((r) => text(r.querySelector("[data-testid=workflow-requirements]")));
  if (keys.join("|") !== KEYS.join("|")) wrong.push(`C2: the rows name requirements ${keys.join(", ")}, not ${KEYS.join(", ")}`);
  const owes = [...document.querySelectorAll("[data-testid=workflows-needs-you]")];
  if (owes.length !== 1 || text(owes[0] ?? null) !== "Needs you None") wrong.push(`C3: ${owes.length} lines say what the viewer owes, reading "${owes.map(text).join(" / ")}"`);
  if (document.body.innerText.includes("No context")) wrong.push('C3: the page still says "No context"');
  const shared = document.querySelector("[data-testid=workflows-shared]");
  if (!shared || !text(shared).includes("orchestrator")) wrong.push(`C4: no line above the list says the shared state once ("${text(shared)}")`);
  const perRow = rows.filter((r) => r.querySelector("[data-testid=design-pill], [data-testid=waiting-on]")).length;
  if (perRow) wrong.push(`C4: ${perRow} rows repeat the shared state`);
  const all = [...document.querySelectorAll("[data-testid=waiting-filter] button")].map(text);
  if (all[0] !== "All") wrong.push(`C4: the waiting filter opens on "${all[0] ?? "nothing"}", not "All"`);
  const counts = [...(document.querySelector("[data-testid=designs]")?.querySelectorAll("span, b") ?? [])].filter((e) => e.childElementCount === 0 && e.textContent?.trim() === String(RECORDS.length)).length;
  if (counts !== 1) wrong.push(`the design count is said ${counts} times`);
  console.log(`ROWS ${rows.map((r) => text(r)).join(" || ")}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => document.querySelectorAll("[data-testid=workflow-row]").length === RECORDS.length,
  stages: [
    { name: "light", run: async () => (theme("light"), await settle(), reader()) },
    { name: "dark", run: async () => (theme("dark"), await settle(), reader()) },
  ],
};

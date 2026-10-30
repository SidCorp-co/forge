// The Workflows page witnessed in the workspace shell as drawn (owner's ask on dev.288): every design
// row reads its title first, its health chips wrapping under it and never taking its place; the system
// map opens fitted to the canvas beside the Designs panel, no box or line label under the panel or cut
// at the canvas edge; and at 390 px the page opens on the list of designs, the map one switch away, its
// zoom bar clear of the tab bar. jsdom lays nothing out, so all of it is read here.
//
//   pnpm --filter web-v2 witness witness/workflows-page.witness.tsx --out <dir>

import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BottomTabBar, TopBarSlotProvider } from "@/design";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { bottomTabItems } from "@/features/shell/nav-model";
import { WorkflowsScreen } from "@/features/workflows/components/workflows-screen";
import type { SystemGraph } from "@/features/workflows/types";
import { graphNode } from "@/test/system-graph";
import { RULE, say, waitingOn } from "@/test/said";
import "./entry";
import { InRouter } from "./router";

const P = "p-forge";
const AT = "2026-10-22T08:00:00.000Z";
const nobody = waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE });
const zero = { outdated: 0, needs_update: 0, has_problem: 0, remove_proposed: 0, upcoming: 0, not_in_design: 0, wrong: 0 };
const health = (over: Partial<typeof zero> = {}, needsYou = 0) => ({ counts: { ...zero, ...over }, needsYou, workflowLevelOnly: false, observed: true, reconciled: false });

const record = (flow: string, title: string, template: string, steps: number, h = health(), kind: "flow" | "state" = "flow") => ({
  revision: 3,
  writer: "u1",
  writerName: "Lan",
  requirements: [],
  design: { shown: "approved", status: "approved", pendingRevision: null, approvedRevision: 3, returnReason: null, waitingOn: nobody },
  document: {
    version: 2,
    project: P,
    flow,
    kind,
    title,
    summary: "",
    template: { id: template, version: 1 },
    steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i}`, title: `Step ${i}`, does: "Does", after: i ? [`s${i - 1}`] : [] })),
    writtenBy: {},
    id: `w-${flow}`,
    createdAt: AT,
    updatedAt: AT,
  },
  health: h,
});

/** dev.290's longest design title, which a judge saw cut to "…arou…" at both widths (ISS-646, REQ-17 BC-29). */
const LONG = "Core components: doors, domains and adapters around the kernel";

/** The designs whose rows carried the most chips on dev.288, beside plain ones and the longest title. */
const RECORDS = [
  record("system-context", "Forge in context", "system-context", 19, health({ wrong: 14, not_in_design: 15, upcoming: 2 }, 20)),
  record("kernel-view", "Core components: the kernel view", "system-context", 10),
  record("core-components", LONG, "system-context", 39),
  record("requirement-to-delivery", "Requirement to delivery", "operational-flow", 40, health({ wrong: 30, not_in_design: 18, upcoming: 25 }, 36)),
  record("issue-delivery", "Issue to release", "operational-flow", 38, health({ wrong: 25, upcoming: 60 }, 11)),
  record("steward-handoffs", "Steward at handoffs", "operational-flow", 22),
  record("issue-lifecycle", "Issue lifecycle", "state-machine", 13, health({ has_problem: 1, wrong: 11, upcoming: 40 }, 9), "state"),
  record("feedback-lifecycle", "Feedback lifecycle", "state-machine", 14, health(), "state"),
  record("personal-data-flow", "Personal data in Forge", "data-flow", 31, health({ wrong: 18, not_in_design: 1, upcoming: 36 }, 5)),
];
const CHIPPED = ["Forge in context", "Requirement to delivery", "Issue to release", "Issue lifecycle", "Personal data in Forge"];

const uses = BUILTIN_WORKFLOW_TEMPLATES.find((t) => t.id === "system-context")?.edgeKinds.find((k) => k.id === "uses");
if (!uses) throw new Error("the system-context template declares no `uses` line");

/** Forge's own context, nine boundaries in a chain with each line labelled: like dev.288's, more than the canvas holds at full size. */
const LANES = [
  ["domains", "Domains"],
  ["doors", "Doors"],
  ["reads", "Read models"],
  ["kernel", "Kernel"],
  ["adapters", "Adapters (ports)"],
  ["platform", "Platform"],
  ["identity", "Identity"],
  ["runners", "Runners"],
  ["hosting", "Hosting"],
] as const;
const nodes = LANES.flatMap(([lane]) => [0, 1, 2].map((i) => graphNode(`${lane}-${i}`, "external", `${lane} part ${i}`, lane)));
const LABELS = ["mounts its routes", "reads what waits on whom", "subscribes to transitions", "reads run facts", "vault and delivery log rows", "writes only the tables it owns"];
const GRAPH: SystemGraph = {
  workflowId: "w-system-context",
  revision: 3,
  against: null,
  focal: { boundary: null, title: "Forge", tip: "", purpose: "", parts: ["forge"] },
  nodes: [graphNode("forge", "system", "Forge"), ...nodes],
  relationships: LANES.flatMap(([lane], i) => [
    { id: `r${i}`, from: "forge", to: `${lane}-0`, label: LABELS[i] ?? "uses", technology: null, kind: uses },
    ...(i > 0 ? [{ id: `c${i}`, from: `${LANES[i - 1]?.[0]}-1`, to: `${lane}-1`, label: LABELS[(i + 3) % LABELS.length] ?? "uses", technology: null, kind: uses }] : []),
  ]),
  boundaries: LANES.map(([lane, label]) => ({ id: `outside:${lane}`, lane, side: "outside" as const, label, tip: "", members: [0, 1, 2].map((i) => `${lane}-${i}`) })),
  facts: { people: [], externals: nodes.length, boundaries: [], namedBoundaries: LANES.length },
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.localStorage.clear();
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname;
  if (path.endsWith(`/projects/${P}/workflows`)) return json({ workflows: RECORDS, returned: RECORDS.length });
  if (path.endsWith(`/projects/${P}/workflow-templates`)) return json({ templates: BUILTIN_WORKFLOW_TEMPLATES.map((template) => ({ origin: "builtin", template })), returned: BUILTIN_WORKFLOW_TEMPLATES.length });
  if (path.endsWith("/system-graph")) return json(GRAPH);
  return new Promise<Response>(() => {});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const phone = window.innerWidth < 768;
const noop = () => {};

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/forge/workflows" pattern="/projects/$slug/workflows">
    <QueryClientProvider client={client}>
      <TopBarSlotProvider>
        <div className="flex h-dvh overflow-hidden bg-shell" data-shell>
          {phone ? null : <div className="h-full flex-none border-r border-line bg-surface" style={{ width: 88 }} />}
          <div className="flex min-w-0 flex-1 flex-col" data-page>
            <ShellTopBar chatOpen={false} onToggleChat={noop} />
            <main className="min-h-0 flex-1 overflow-y-auto bg-app pb-[calc(56px+env(safe-area-inset-bottom))] window-md:pb-0" data-witness="main">
              {/* the project route's frame, routes/_workspace/projects/$slug/route.tsx: the page fills the pane */}
              <div className="flex min-h-full min-w-0 flex-col">
                <WorkflowsScreen projectId={P} slug="forge" projectName="Forge" canEdit />
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
const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
const visible = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
};
const flowNodes = () => [...document.querySelectorAll(".react-flow__node")].filter(visible);
const tabBarTop = () => document.querySelector("nav[aria-label] button")?.closest("nav")?.getBoundingClientRect().top ?? window.innerHeight;

function sideways(): string[] {
  return document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : [];
}

/** Each design row reads its title, whole enough to read, above or beside its chips and never displaced by them. */
function titlesFirst(): string[] {
  const wrong: string[] = [];
  const rows = [...document.querySelectorAll<HTMLElement>("[data-testid=workflow-row]")];
  if (rows.length !== RECORDS.length) wrong.push(`${rows.length} design rows are drawn, not ${RECORDS.length}`);
  for (const name of CHIPPED) {
    const row = rows.find((r) => r.textContent?.includes(name));
    if (!row) {
      wrong.push(`no row reads "${name}"`);
      continue;
    }
    const title = [...row.querySelectorAll("span")].find((s) => s.textContent === name);
    const t = title?.getBoundingClientRect();
    if (!t || t.width < 120) wrong.push(`"${name}" draws its title ${t ? `${Math.round(t.width)} px wide` : "nowhere"}: the chips took its place`);
    const chips = row.querySelector("[data-testid=health-summary]")?.getBoundingClientRect();
    if (t && chips && chips.top < t.top - 0.5) wrong.push(`"${name}"'s chips sit above its title`);
  }
  // every title reads whole, wrapping where it must: nothing is cut to an ellipsis (REQ-17 BC-29)
  for (const r of RECORDS) {
    const name = r.document.title;
    // the title and every box holding only it: any of them narrower than its text cuts the title
    const holders = [...document.querySelectorAll<HTMLElement>("[data-testid=workflow-row] span")].filter((x) => x.textContent === name);
    const cut = holders.find((x) => x.scrollWidth > x.clientWidth + 0.5);
    if (holders.length === 0) wrong.push(`no row draws the title "${name}"`);
    else if (cut) wrong.push(`"${name}" is cut: ${Math.round(cut.clientWidth)} px of its ${Math.round(cut.scrollWidth)} show`);
  }
  return wrong;
}

/** The map opens with every box and line label inside the canvas, none under the Designs panel. */
function mapFits(): string[] {
  const flow = rect("[data-testid=overview-diagram] .react-flow");
  if (!flow) return ["no map is drawn"];
  const pane = rect("[data-testid=workflows-list-pane]");
  const right = Math.min(flow.right, pane && pane.width > 0 && pane.left > flow.left ? pane.left : flow.right);
  const wrong: string[] = [];
  const parts = [...flowNodes(), ...document.querySelectorAll(".react-flow__edgelabel-renderer > *, .react-flow__edge-text, .react-flow__edge-textwrapper")].filter(visible);
  if (flowNodes().length === 0) wrong.push("the map draws no box");
  for (const el of parts) {
    const r = el.getBoundingClientRect();
    if (r.left < flow.left - 0.5 || r.right > right + 0.5 || r.top < flow.top - 0.5 || r.bottom > flow.bottom + 0.5) {
      wrong.push(`"${(el.textContent ?? "").trim().slice(0, 30)}" opens outside the visible canvas (${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(flow.left)}–${Math.round(right)})`);
    }
  }
  return wrong;
}

/** At 390 px the page opens on the designs: the first row in view above the tab bar, no map to pan past. */
function phoneList(): string[] {
  const wrong = sideways();
  const first = document.querySelector("[data-testid=workflow-row]")?.getBoundingClientRect();
  if (!first || first.top >= tabBarTop()) wrong.push(`the first design row is not in view above the tab bar (top ${first ? Math.round(first.top) : "none"}, bar ${Math.round(tabBarTop())})`);
  if (flowNodes().length > 0) wrong.push("the map is drawn over the list, so a swipe pans it instead of scrolling to the designs");
  if (!document.querySelector("[data-testid=workflows-view]")) wrong.push("there is no switch between the designs and the map");
  return wrong;
}

function showMap(): string[] {
  const map = document.querySelector<HTMLElement>("[data-testid=workflows-view] [role=radio][data-value=map], [data-testid=workflows-view] button:last-child");
  if (!map) return ["no switch to the map"];
  map.click();
  return [];
}

/** On the map, its zoom bar and every box sit above the tab bar. */
function phoneMap(): string[] {
  const wrong = sideways();
  const bar = document.querySelector("[data-testid=overview-diagram] [role=toolbar]:last-of-type, [data-testid=overview-diagram] .wfc-br")?.getBoundingClientRect();
  const zoom = [...document.querySelectorAll("[data-testid=overview-diagram] button")].find((b) => b.textContent?.trim() === "+")?.getBoundingClientRect() ?? bar;
  if (!zoom) wrong.push("the map draws no zoom bar");
  else if (zoom.bottom > tabBarTop() + 0.5) wrong.push(`the zoom bar ends at ${Math.round(zoom.bottom)}, under the tab bar at ${Math.round(tabBarTop())}`);
  return [...wrong, ...mapFits()];
}

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => document.querySelectorAll("[data-testid=workflow-row]").length === RECORDS.length && (phone || flowNodes().length > 0),
  stages: phone
    ? [
        { name: "list-light", run: async () => (theme("light"), await settle(), [...phoneList(), ...titlesFirst()]) },
        { name: "list-dark", run: async () => (theme("dark"), await settle(), [...phoneList(), ...titlesFirst()]) },
        { name: "map-light", run: async () => (theme("light"), showMap(), await settle(1200), phoneMap()) },
        { name: "map-dark", run: async () => (theme("dark"), await settle(), phoneMap()) },
      ]
    : [
        { name: "page-light", run: async () => (theme("light"), await settle(1200), [...sideways(), ...titlesFirst(), ...mapFits()]) },
        { name: "page-dark", run: async () => (theme("dark"), await settle(), [...titlesFirst(), ...mapFits()]) },
      ],
};

// A requirement's page at 1440 and at 390 by 900, in light then dark (ISS-691, REQ-65 BC-7; face
// ISS-903): its header (the title, the key only its tooltip, the state, the one next act), its
// picture — the linked workflow with the steps its criteria touch lit, the pane as tall as the drawing
// with no step cut at its edge — then Problem, Value and Measured by, then the criteria as one short
// line a row and "Still unclear" shut to one line. Each first-view stage counts the words a person sees
// before scrolling (witness/first-screen.ts) and fails over the page's word budget; two more stages
// open a criterion and the unclear questions, and fail where the opened criterion repeats its line.
//
//   pnpm --filter web-v2 witness witness/requirement-page.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { RequirementScreen } from "@/features/requirements/components/requirement-screen";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import type { RequirementDetail } from "@/features/requirements/types";
import { reqDetail } from "@/test/vi-chrome-requirements";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";
import { BUDGETS } from "./screens.budgets";

/** The requirement page's word budget on its first view (REQ-11 BC-21). */
const MOST_WORDS = BUDGETS["requirement-detail"].budget;

const P = "7f1c1d1e-0000-4000-8000-000000000691";
const AT = "2026-11-02T08:00:00.000Z";
const STEPS = ["Cart", "Address", "Pay", "Confirm", "Ship"];

const WORKFLOW = {
  workflowId: "w-checkout",
  revision: 3,
  writer: "u1",
  writerName: "Lan",
  requirements: [],
  design: { status: "approved", approvedRevision: 3 },
  document: {
    version: 2,
    project: P,
    flow: "checkout",
    kind: "flow",
    title: "Checkout",
    summary: "",
    template: { id: "operational-flow", version: 1 },
    steps: STEPS.map((title, i) => ({ id: title.toLowerCase(), title, does: title, after: i ? [STEPS[i - 1]?.toLowerCase()] : [], node: { type: "TASK", label: title } })),
    writtenBy: {},
    id: "w-checkout",
    createdAt: AT,
    updatedAt: AT,
  },
};

const current = reqDetail.revisions.find((r) => r.state === "current") as RequirementDetail["revisions"][number];
const D: RequirementDetail = {
  ...reqDetail,
  key: "REQ-65",
  title: "Checkout takes a card",
  revisions: [
    {
      ...current,
      kind: "process",
      picture: null,
      writtenLang: "en",
      tldr: null,
      spec: {
        ...current.spec,
        goal: "Problem: buyers leave when checkout asks for the card twice.\nValue: a buyer pays in one step.\nMeasured by: checkouts finished per day.\nRoadmap: Now",
      },
    },
  ],
  workflows: [{ workflowId: "w-checkout", flow: "checkout", title: "Checkout", designStatus: "approved", approvedRevision: 3 }],
  traces: [
    { code: "BC-1", workflowId: "w-checkout", flow: "checkout", steps: ["pay"], edges: [{ from: "address", to: "pay" }] },
    { code: "BC-2", workflowId: "w-checkout", flow: "checkout", steps: ["confirm"], edges: [] },
  ],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if (path === "/projects") return json([{ id: P, slug: "hop", name: "Hop", role: "viewer", orgId: null }]);
  if (path === `/projects/${P}/workflows`) return json({ workflows: [WORKFLOW], returned: 1 });
  if (path === `/projects/${P}/workflow-templates`) return json({ templates: [] });
  // a read no fixture answers stays in flight, drawing its loading state
  return new Promise<Response>(() => {});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["requirement", P, D.key], D);

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

/** A first view at the stage's theme: the workflow drawn whole, no step cut at the pane's edge, within the budget. */
const firstView = (t: "light" | "dark") => async () => {
  theme(t);
  window.scrollTo(0, 0);
  await pause(1200);
  if (window.innerHeight !== 900) return [`the window is ${window.innerHeight} px tall, not 900`];
  const wrong: string[] = [];
  const pane = q("[data-testid=picture-workflow]");
  if (!pane) wrong.push("the linked workflow is not drawn");
  else {
    if (!pane.hasAttribute("data-fitted")) wrong.push("the workflow pane was never fitted to its drawing");
    const box = pane.getBoundingClientRect();
    const nodes = [...pane.querySelectorAll<HTMLElement>(".react-flow__node")].map((n) => n.getBoundingClientRect());
    const top = Math.min(...nodes.map((n) => n.top));
    if (top - box.top > 80) wrong.push(`the workflow pane stands ${Math.round(top - box.top)} px empty above its first step`);
    const bottom = Math.max(...nodes.map((n) => n.bottom));
    if (box.bottom - bottom > 40) wrong.push(`the workflow pane stands ${Math.round(box.bottom - bottom)} px empty below its steps`);
    const wide = window.innerWidth >= 1000;
    if (wide && nodes.some((n) => n.left < box.left || n.right > box.right)) wrong.push("a step of the workflow is cut at the pane's edge at 1440");
    if (!wide && nodes.some((n) => n.left < box.left - 1 && n.right > box.left + 1)) wrong.push("a step of the workflow is cut at the pane's left edge");
  }
  // the tabs stand in one row at every width: a phone keeps the open one and puts the rest behind More (ISS-903)
  const rows = new Set([...document.querySelectorAll<HTMLElement>("[data-testid=requirement-tabs] [role=tab]")].map((x) => Math.round(x.getBoundingClientRect().top)));
  if (rows.size > 1) wrong.push(`the tabs wrap onto ${rows.size} rows at ${window.innerWidth} px`);
  const { count, words } = firstScreenWords(q("[data-witness=page]") as HTMLElement);
  console.log(`requirement ${t} ${window.innerWidth}: ${count} words on the first screen: ${words.join(" ")}`);
  if (count > MOST_WORDS) wrong.push(`the page shows ${count} words on its first screen, over ${MOST_WORDS}; it starts: ${words.slice(0, 40).join(" ")}`);
  return wrong;
};

window.__witness = {
  cases: [
    { name: "wide-1440", width: 1440 },
    { name: "narrow-390", width: 390 },
  ],
  ready: () => Boolean(q("[data-testid=view-overview]")),
  stages: [
    { name: "light", run: firstView("light") },
    { name: "dark", run: firstView("dark") },
    {
      name: "criterion-expanded",
      run: async () => {
        theme("light");
        const line = q("[data-testid=criterion-line]");
        if (!line) return ["the page draws no criterion line to open"];
        line.click();
        await pause(300);
        line.scrollIntoView({ block: "start" });
        const row = line.closest("[data-testid=criterion-row]");
        const said = line.textContent?.trim() ?? "";
        const wording = row?.querySelector("[data-testid=criterion-wording]")?.textContent?.trim();
        return wording === said ? [`the opened criterion says its line again: "${said}"`] : [];
      },
    },
    {
      name: "unclear-expanded",
      run: async () => {
        const fold = q("[data-testid=unclear-fold] button");
        if (!fold) return ["the page draws no Still unclear line to open"];
        fold.click();
        await pause(300);
        fold.scrollIntoView({ block: "start" });
        return document.querySelectorAll("[data-testid=unclear-question]").length > 0 ? [] : ["Still unclear opened onto no question"];
      },
    },
  ],
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <InRouter at={`/projects/hop/requirements/${D.key}`} pattern="/projects/$slug/requirements/$requirement">
    <QueryClientProvider client={client}>
      <TopBarSlotProvider>
        <div className="min-h-screen bg-app text-fg" data-witness="page">
          <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
          <RequirementScreen projectId={P} slug="hop" reqKey={D.key} />
        </div>
      </TopBarSlotProvider>
    </QueryClientProvider>
  </InRouter>,
);

// A requirement's page at 1440 by 900, in light then dark (ISS-691, REQ-65 BC-7): it reads its
// picture, the linked workflow with the steps its criteria touch lit, then Problem, Value and
// Measured by on one line each, then the criteria as one short line a row. Each stage counts the words
// a person sees before scrolling (witness/first-screen.ts) and fails over the owner's 120 (2026-11-02).
//
//   pnpm --filter web-v2 witness witness/requirement-page.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { RequirementPage } from "@/features/requirements/components/requirement-detail";
import type { RequirementDetail } from "@/features/requirements/types";
import { reqDetail } from "@/test/vi-chrome-requirements";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";

/** The owner's most words on a screen's first view (2026-11-02). */
const MOST_WORDS = 120;

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

window.__witness = {
  cases: [{ name: "wide-1440", width: 1440 }],
  ready: () => Boolean(q("[data-testid=view-overview]")),
  stages: (["light", "dark"] as const).map((t) => ({
    name: t,
    run: async () => {
      theme(t);
      window.scrollTo(0, 0);
      await pause(1200);
      if (window.innerHeight !== 900) return [`the window is ${window.innerHeight} px tall, not 900`];
      const wrong: string[] = [];
      if (!q("[data-testid=picture-workflow]")) wrong.push("the linked workflow is not drawn");
      const { count, words } = firstScreenWords(q("[data-witness=page]") as HTMLElement);
      console.log(`requirement ${t}: ${count} words on the first screen: ${words.join(" ")}`);
      if (count > MOST_WORDS) wrong.push(`the page shows ${count} words on its first screen, over ${MOST_WORDS}; it starts: ${words.slice(0, 40).join(" ")}`);
      return wrong;
    },
  })),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <InRouter at={`/projects/hop/requirements/${D.key}`} pattern="/projects/$slug/requirements/$requirement">
    <QueryClientProvider client={client}>
      <div className="min-h-screen bg-app text-fg" data-witness="page">
        <RequirementPage projectId={P} slug="hop" reqKey={D.key} tab="overview" onTab={() => {}} />
      </div>
    </QueryClientProvider>
  </InRouter>,
);

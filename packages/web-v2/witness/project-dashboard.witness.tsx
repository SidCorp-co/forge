// The project Dashboard as one page, mounted whole over a stubbed core: its headline figures, the
// pictures under them and the lists last. At 390 px nothing scrolls sideways, and every read the page
// sends is answered, so a shot is never one of a page still loading.
//
//   pnpm --filter web-v2 witness witness/project-dashboard.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Route } from "@/routes/_workspace/projects/$slug/index";
import { APPROVALS_PROJECT as PH, APPROVALS_READ } from "@/test/approvals-read";
import { STATUS } from "@/test/project-status";
import "./entry";
import { InRouter } from "./router";

const NOW = "2026-10-21T09:00:00.000Z";
const day = (i: number) => new Date(Date.parse(NOW) - (29 - i) * 86_400_000).toISOString().slice(0, 10);
const wave = (i: number, k: number) => Math.max(0, Math.round(3 + 3 * Math.sin((i + k) / 3) + ((i * 7 + k) % 4)));

const HEALTH = {
  days: 30,
  series: Array.from({ length: 30 }, (_, i) => ({ day: day(i), throughput: wave(i, 0), stepFailures: wave(i, 5) % 4, retries: wave(i, 2) % 3, interventions: i % 9 === 0 ? 1 : 0 })),
  totals: { throughput: 128, stepFailures: 41, retries: 22, interventions: 4 },
  previous: { throughput: 97, stepFailures: 55, retries: 22, interventions: 7 },
};

const STATE = (s: string) => ({ standing: { state: s } });
const REQUIREMENTS = {
  requirements: [
    ...Array.from({ length: 3 }, (_, i) => ({ key: `REQ-${i + 1}`, title: `Draft ${i}`, ...STATE("draft") })),
    ...Array.from({ length: 5 }, (_, i) => ({ key: `REQ-${i + 10}`, title: `Agreed ${i}`, ...STATE("agreed") })),
    ...Array.from({ length: 7 }, (_, i) => ({ key: `REQ-${i + 20}`, title: `Delivery ${i}`, ...STATE("in_delivery") })),
    ...Array.from({ length: 11 }, (_, i) => ({ key: `REQ-${i + 40}`, title: `Delivered ${i}`, ...STATE("delivered") })),
  ],
};
const feedbackRow = (i: number, phase: string, stuck: boolean) => ({ key: `FB-${i}`, title: `Feedback ${i}`, phase, attentionGroup: "open", snoozed: false, times: { stuck: stuck ? NOW : null } });
const FEEDBACK = { feedback: [...Array.from({ length: 4 }, (_, i) => feedbackRow(i, "new", false)), ...Array.from({ length: 9 }, (_, i) => feedbackRow(i + 10, "in_delivery", i < 2))] };

const ROADMAP = {
  ...STATUS.roadmap,
  now: [
    { key: "REQ-4", title: "Referrals", state: "in_delivery", delivery: null, deferral: null },
    { key: "REQ-21", title: "Clinic checkout", state: "in_delivery", delivery: null, deferral: null },
    { key: "REQ-22", title: "Invoice export", state: "in_delivery", delivery: null, deferral: null },
  ],
  next: [
    { key: "REQ-10", title: "Staff roles", state: "agreed", delivery: null, deferral: null },
    { key: "REQ-11", title: "Audit log", state: "agreed", delivery: null, deferral: null },
  ],
};
const PROJECT_STATUS = {
  ...STATUS,
  projectId: PH,
  roadmap: ROADMAP,
  requirements: { ...STATUS.requirements, proven: 31, total: 46 },
  inFlight: { ...STATUS.inFlight, byStatus: [{ status: "open", count: 9 }, { status: "in_progress", count: 4 }, { status: "in_review", count: 2 }, { status: "awaiting_release", count: 5 }], open: 20, runningCount: 1 },
};

const release = (version: string, state: string, current: boolean) => ({
  key: version, version, runId: null, state, current, landedOn: null, name: null, summary: null, issueCount: 6, requirements: [], contents: [], owner: null, ownerAct: null,
  criteria: { proven: 0, total: 0 }, verified: { level: "none", proven: 0, total: 0, check: null, provider: null, judgedOn: null },
});
const RELEASES = {
  releases: [release("0.4.0", "draft", false), release("0.3.2", "shipped", true)],
  counts: {},
  approvalRequired: true,
  production: { ok: true, url: "https://api.hop.example" },
  landings: [],
};
const MODULES = { modules: ["Patients", "Bookings", "Billing", "Staff", "Reports"].map((name, i) => ({ id: `m${i}`, name, slug: name.toLowerCase(), parentId: null })) };
const CONFIG = { declared: true, revision: 1, document: { project: { description: "The clinic back office: patients, bookings and billing over one API." } } };
const STEWARD_DAY = { day: NOW, resumesAt: NOW, handoff: { gatewayTurns: { spent: 6, of: 80 }, runnerJobs: { spent: 1, of: 4 } }, sweep: { gatewayTurns: { spent: 2, of: 120 }, runnerJobs: { spent: 0, of: 6 } }, paced: 0, quiet: null };

const READS: [RegExp, () => unknown][] = [
  [/^\/projects$/, () => [{ id: PH, slug: "hop", name: "Hop Clinic API", role: "admin", orgId: null, orgRole: null }]],
  [/\/needs-you\/decisions$/, () => APPROVALS_READ],
  [/\/status$/, () => PROJECT_STATUS],
  [/\/metrics\/health$/, () => HEALTH],
  [/^\/projects\/[^/]+\/requirements$/, () => REQUIREMENTS],
  [/^\/projects\/[^/]+\/feedback$/, () => FEEDBACK],
  [/\/forecast\/requirements$/, () => ({ projectId: PH, requirements: [] })],
  [/\/forecast\/feedback$/, () => ({ projectId: PH, items: [] })],
  [/\/releases$/, () => RELEASES],
  [/\/workflows$/, () => ({ workflows: [], returned: 0 })],
  [/\/workflow-templates$/, () => ({ templates: [] })],
  [/\/config$/, () => CONFIG],
  [/\/modules\/rollup$/, () => MODULES],
  [/\/steward-budget$/, () => STEWARD_DAY],
  [/^\/memory\/entries$/, () => ({ items: [], counts: { live: 0, superseded: 0, archived: 0 }, returned: 0, total: 0, limit: 100 })],
];
/** Reads the page draws nothing from when they fail: refused, so the shot is not one still waiting. */
const REFUSED = [/\/forecast\/releases\/coming$/, /\/onboarding$/];

const unanswered = new Set<string>();
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://forge.test");
  const path = url.pathname.replace(/^\/api/, "");
  for (const [pattern, answer] of READS) if (pattern.test(path)) return json(answer());
  if (REFUSED.some((p) => p.test(path))) return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "none" } }), { status: 404, headers: { "content-type": "application/json" } });
  unanswered.add(`${init?.method ?? "GET"} ${path}${url.search}`);
  return new Promise<Response>(() => {});
};

const Page = Route.options.component as () => React.ReactNode;

function Shell() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } }));
  return (
    <QueryClientProvider client={client}>
      <InRouter at="/projects/hop" pattern="/projects/$slug">
        <div className="min-h-dvh bg-app" data-witness="page">
          <Page />
        </div>
      </InRouter>
    </QueryClientProvider>
  );
}

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => Boolean(document.querySelector("[data-witness=page] h1")),
  stages: (["light", "dark"] as const).map((t) => ({
    name: t,
    run: async () => {
      theme(t);
      await pause(900);
      const wide = document.documentElement.scrollWidth > window.innerWidth ? [`the dashboard scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : [];
      return [...wide, ...[...unanswered].map((r) => `core was sent ${r} and nothing answers it`)];
    },
  })),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(<Shell />);

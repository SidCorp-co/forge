// ISS-1006 round 2, as the owner reads it: the forge project's seven pending decisions on dev.513
// (`decision-fallback.fixture.json`, its `needs-you/decisions` read; none carries plain text), at
// 1440 px light and 420 px dark:
// - approvals-none, peek-none, dashboard-none: with no plain text, each Approvals row reads its
//   question's own line beside "No summary", the peek its question, the marker and the recommended
//   answer, and the dashboard's Needs you list the question's line, as they read before round 1;
// - approvals-plain, peek-plain, dashboard-plain: the same decisions once their askers wrote plain
//   text (as `PUT /api/questions/:id/plain` writes it), each place reading its first line.
//
//   pnpm --filter web-v2 witness witness/decision-fallback.witness.tsx --out <dir>

import { decisionLineOf } from "@forge/contracts/plain-decision";
import { type NeedsYouDecisions, needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { ApprovalsScreen } from "@/features/approvals";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { Route } from "@/routes/_workspace/projects/$slug/index";
import { STATUS } from "@/test/project-status";
import fixture from "./decision-fallback.fixture.json";
import "./entry";
import { InRouter } from "./router";

const P = "d1bb4907-74d9-4228-85ff-76121523af7d";
const AT = "2026-11-05T10:00:00.000Z";
const NONE: NeedsYouDecisions = needsYouDecisionsSchema.parse(fixture);

/** What each asker would write, three plain lines in the reader's language. */
const PLAINS = [
  "Channel bots get the same powers as a session, one channel at a time.\nThe Orbit channel waits on it.\nI recommend starting with Orbit only.",
  "The release check gets one more fix round before it ships.\nThe Delivery page waits on it.\nI recommend the second round.",
  "The delivery check gets one more fix round, judged live.\nThe Delivery page waits on it.\nI recommend the second round.",
  "Product tours are drawn with the screens they visit.\nThe Hop design waits on it.\nI recommend the guide-only convention.",
  "Runs reach servers with short-lived keys Forge hands out.\nServer work waits on it.\nI recommend read-only access first.",
  "Feedback triage can be switched to anyone who writes.\nTriage of new feedback waits on it.\nI recommend keeping it a person's act.",
  "A red daily suite names the merge that broke it.\nRelease cuts wait on it.\nI recommend a scoped repository secret.",
];
const PLAIN: NeedsYouDecisions = { ...NONE, decisions: NONE.decisions.map((d, i) => ({ ...d, plain: PLAINS[i] ?? null })) };

const at: { read: NeedsYouDecisions } = { read: NONE };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const READS: [RegExp, () => unknown][] = [
  [/^\/projects$/, () => [{ id: P, slug: "forge", name: "Forge", role: "admin", orgId: null, orgRole: null }]],
  [/\/needs-you\/decisions$/, () => at.read],
  [/^\/projects\/[^/]+\/status$/, () => ({ ...STATUS, projectId: P })],
  [/\/metrics\/health$/, () => ({ days: 30, series: [], totals: { throughput: 0, stepFailures: 0, retries: 0, interventions: 0 }, previous: { throughput: 0, stepFailures: 0, retries: 0, interventions: 0 } })],
  [/^\/projects\/[^/]+\/requirements$/, () => ({ requirements: [] })],
  [/^\/projects\/[^/]+\/feedback$/, () => ({ feedback: [] })],
  [/\/forecast\/requirements$/, () => ({ projectId: P, requirements: [] })],
  [/\/forecast\/feedback$/, () => ({ projectId: P, items: [] })],
  [/\/releases$/, () => ({ releases: [], counts: {}, approvalRequired: false, production: { ok: true, url: null }, landings: [] })],
  [/\/workflows$/, () => ({ workflows: [], returned: 0 })],
  [/\/workflow-templates$/, () => ({ templates: [] })],
  [/\/config$/, () => ({ declared: true, revision: 1, document: { project: { description: "The control plane." } } })],
  [/\/modules\/rollup$/, () => ({ modules: [] })],
  [/\/steward-budget$/, () => ({ day: AT, resumesAt: AT, handoff: { gatewayTurns: { spent: 0, of: 80 }, runnerJobs: { spent: 0, of: 4 } }, sweep: { gatewayTurns: { spent: 0, of: 120 }, runnerJobs: { spent: 0, of: 6 } }, paced: 0, quiet: null })],
  [/^\/memory\/entries$/, () => ({ items: [], counts: { live: 0, superseded: 0, archived: 0 }, returned: 0, total: 0, limit: 100 })],
  [/^\/conversations$/, () => ({ items: [], total: 0 })],
];
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname.replace(/^\/api/, "");
  for (const [pattern, reply] of READS) if (pattern.test(path)) return json(reply());
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "none" } }), { status: 404, headers: { "content-type": "application/json" } });
};
window.localStorage.clear();

type Screen = "approvals" | "dashboard";
const scene: { set: (s: { screen: Screen; plain: boolean }) => void } = { set: () => {} };
const Dashboard = Route.options.component as () => React.ReactNode;

function Scenes() {
  const [s, setS] = useState<{ screen: Screen; plain: boolean }>({ screen: "approvals", plain: false });
  scene.set = (next) => {
    at.read = next.plain ? PLAIN : NONE;
    // the peek a scene opened is in the window's own address: each scene starts with none open
    window.history.replaceState(null, "", window.location.pathname);
    setS(next);
  };
  // a fresh client per scene, so each reads its own decisions
  const [clients] = useState(() => new Map<string, QueryClient>());
  const key = `${s.screen}:${s.plain}`;
  if (!clients.has(key)) clients.set(key, new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } }));
  const client = clients.get(key) as QueryClient;
  return (
    <QueryClientProvider client={client} key={key}>
      <InRouter at={s.screen === "approvals" ? "/projects/forge/approvals" : "/projects/forge"} pattern={s.screen === "approvals" ? "/projects/$slug/approvals" : "/projects/$slug"}>
        <TopBarSlotProvider>
          <div className="flex min-h-dvh min-w-0 flex-col bg-app">
            <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
            <main className="min-w-0 flex-1">{s.screen === "approvals" ? <ApprovalsScreen projectId={P} slug="forge" /> : <Dashboard />}</main>
          </div>
        </TopBarSlotProvider>
      </InRouter>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Scenes />);

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const all = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = () => {
  const t = window.innerWidth < 600 ? "dark" : "light";
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

async function until(test: () => boolean, what: string): Promise<string[]> {
  for (let i = 0; i < 60; i++) {
    if (test()) return [];
    await pause(100);
  }
  return [`${what} was never drawn`];
}

const lineOf = (d: NeedsYouDecisions["decisions"][number]) => decisionLineOf(d).line;
const sideways = () => (document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : []);

/** Each row drawn reads the line its decision is listed by, and the marker only where no plain text was written. */
function rowsRead(read: NeedsYouDecisions, plain: boolean): string[] {
  const wrong = sideways();
  const rows = all("[data-testid=approval-row]");
  if (rows.length === 0) return ["no Approvals row is drawn"];
  for (const row of rows) {
    const d = read.decisions.find((x) => x.id === row.dataset.rowKey);
    if (!d) continue;
    const line = row.querySelector(plain ? "[data-testid=approval-row-plain]" : "[data-testid=approval-row-question]")?.textContent ?? "";
    if (line !== lineOf(d)) wrong.push(`row ${d.id} reads "${line}", not "${lineOf(d)}"`);
    const marker = row.querySelector<HTMLElement>("[data-testid=approval-row-no-plain]");
    if (Boolean(marker) === plain) wrong.push(`row ${d.id} ${plain ? "says No summary over plain text" : "has no No summary marker"}`);
    // the marker is seen, not cut off past a long line's ellipsis
    const box = marker?.getBoundingClientRect();
    const holder = row.querySelector<HTMLElement>("[data-testid=approval-proposal]")?.getBoundingClientRect();
    if (box && holder && (box.width === 0 || box.right > holder.right + 0.5)) wrong.push(`row ${d.id}'s No summary marker is cut off`);
  }
  return wrong;
}

async function openFirst(plain: boolean): Promise<string[]> {
  all("[data-testid=approval-open]")[0]?.click();
  const missing = await until(() => Boolean(q(plain ? "[data-testid=approval-peek-plain]" : "[data-testid=approval-peek-question]")), "the peek's line");
  // the peek slides in: it is read once it stands inside the window
  await pause(800);
  const r = q("[data-testid=approval-peek]")?.getBoundingClientRect();
  if (!r || r.width === 0 || r.left >= window.innerWidth || r.right <= 0) missing.push("the peek is not in view");
  if (plain) return missing;
  const recommended = q("[data-testid=approval-peek-fallback]")?.innerText ?? "";
  return [...missing, ...(recommended.includes("No summary") ? [] : ["the peek's fallback has no No summary marker"])];
}

async function dashboardReads(read: NeedsYouDecisions): Promise<string[]> {
  const missing = await until(() => all("[data-testid=needs-you-decision-question]").length > 0, "the dashboard's Needs you list");
  const wrong = [...missing, ...sideways()];
  for (const p of all("[data-testid=needs-you-decision-question]")) {
    const said = p.textContent ?? "";
    if (!read.decisions.some((d) => said.startsWith(lineOf(d)))) wrong.push(`the dashboard lists "${said.slice(0, 80)}", which is no decision's line`);
  }
  q("[data-testid=status-needs-you], [data-testid=needs-you-decisions]")?.scrollIntoView({ block: "start" });
  return wrong;
}

window.__witness = {
  cases: [
    { name: "light-1440", width: 1440 },
    { name: "dark-420", width: 420 },
  ],
  ready: () => all("[data-testid=approval-row]").length > 0,
  stages: [
    { name: "approvals-none", run: () => (theme(), rowsRead(NONE, false)) },
    { name: "peek-none", run: () => openFirst(false) },
    {
      name: "dashboard-none",
      run: async () => {
        scene.set({ screen: "dashboard", plain: false });
        return dashboardReads(NONE);
      },
    },
    {
      name: "approvals-plain",
      run: async () => {
        scene.set({ screen: "approvals", plain: true });
        const missing = await until(() => all("[data-testid=approval-row-plain]").length > 0, "the rows' plain text");
        return [...missing, ...rowsRead(PLAIN, true)];
      },
    },
    { name: "peek-plain", run: () => openFirst(true) },
    {
      name: "dashboard-plain",
      run: async () => {
        scene.set({ screen: "dashboard", plain: true });
        return dashboardReads(PLAIN);
      },
    },
  ],
};

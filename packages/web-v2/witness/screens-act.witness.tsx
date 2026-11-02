// The six screens REQ-11 BC-18..BC-21 judge — project home, an issue, requirements, feedback,
// releases and ops — each in the shell at 1440 by 900, in light then dark. Every stage counts the
// words a person sees before scrolling (witness/first-screen.ts) and fails a screen over 300.
//
//   pnpm --filter web-v2 witness witness/screens-act.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { Component, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { IssueDetailScreen } from "@/features/issues/components/issue-detail-screen";
import { OpsMonitor } from "@/features/pipeline";
import { pipelineKeys } from "@/features/pipeline/queries";
import { ReleasesScreen } from "@/features/releases/components/releases-screen";
import { RequirementsScreen } from "@/features/requirements/components/requirements-screen";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { Route as HomeRoute } from "@/routes/_workspace/projects/$slug/index";
import { APPROVALS_PROJECT as PH, APPROVALS_READ } from "@/test/approvals-read";
import { STATUS } from "@/test/project-status";
import { FEEDBACK_SEED, P as FB_P } from "@/test/vi-chrome-feedback";
import { detailQueries } from "@/test/vi-chrome-issues";
import { P as REL_P, releaseSeed } from "@/test/vi-chrome-rel-wf";
import { REQ_PROJECT, reqQueries, Seeded } from "@/test/vi-chrome-requirements";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";

/** REQ-11 BC-21: the most words a screen's first view shows. */
const MOST_WORDS = 300;

const NOW = "2026-10-21T09:00:00.000Z";
const day = (i: number) => new Date(Date.parse(NOW) - (29 - i) * 86_400_000).toISOString().slice(0, 10);
const wave = (i: number, k: number) => Math.max(0, Math.round(3 + 3 * Math.sin((i + k) / 3) + ((i * 7 + k) % 4)));

// ── the project home's reads, answered over a stubbed fetch (as witness/project-dashboard.witness.tsx) ──
const STATE = (s: string) => ({ standing: { state: s } });
const HOME_READS: [RegExp, () => unknown][] = [
  [/^\/projects$/, () => [{ id: PH, slug: "hop", name: "Hop Clinic API", role: "admin", orgId: null, orgRole: null }]],
  [/\/needs-you\/decisions$/, () => APPROVALS_READ],
  [
    /\/status$/,
    () => ({
      ...STATUS,
      projectId: PH,
      roadmap: {
        ...STATUS.roadmap,
        now: [
          { key: "REQ-4", title: "Referrals", state: "in_delivery", delivery: null, deferral: null },
          { key: "REQ-21", title: "Clinic checkout", state: "in_delivery", delivery: null, deferral: null },
        ],
        next: [{ key: "REQ-10", title: "Staff roles", state: "agreed", delivery: null, deferral: null }],
      },
      requirements: { ...STATUS.requirements, proven: 31, total: 46 },
      inFlight: { ...STATUS.inFlight, byStatus: [{ status: "open", count: 9 }, { status: "in_progress", count: 4 }], open: 20, runningCount: 1 },
    }),
  ],
  [
    /\/metrics\/health$/,
    () => ({
      days: 30,
      series: Array.from({ length: 30 }, (_, i) => ({ day: day(i), throughput: wave(i, 0), stepFailures: wave(i, 5) % 4, retries: wave(i, 2) % 3, interventions: i % 9 === 0 ? 1 : 0 })),
      totals: { throughput: 128, stepFailures: 41, retries: 22, interventions: 4 },
      previous: { throughput: 97, stepFailures: 55, retries: 22, interventions: 7 },
    }),
  ],
  [
    /^\/projects\/[^/]+\/requirements$/,
    () => ({
      requirements: [
        ...Array.from({ length: 3 }, (_, i) => ({ key: `REQ-${i + 1}`, title: `Draft ${i}`, ...STATE("draft") })),
        ...Array.from({ length: 5 }, (_, i) => ({ key: `REQ-${i + 10}`, title: `Agreed ${i}`, ...STATE("agreed") })),
        ...Array.from({ length: 7 }, (_, i) => ({ key: `REQ-${i + 20}`, title: `Delivery ${i}`, ...STATE("in_delivery") })),
      ],
    }),
  ],
  [/^\/projects\/[^/]+\/feedback$/, () => ({ feedback: Array.from({ length: 9 }, (_, i) => ({ key: `FB-${i}`, title: `Feedback ${i}`, phase: i < 4 ? "new" : "in_delivery", attentionGroup: "open", snoozed: false, times: { stuck: null } })) })],
  [/\/forecast\/requirements$/, () => ({ projectId: PH, requirements: [] })],
  [/\/forecast\/feedback$/, () => ({ projectId: PH, items: [] })],
  [
    /\/releases$/,
    () => ({
      releases: [
        { key: "0.4.0", version: "0.4.0", state: "draft", current: false, issueCount: 6, requirements: [], contents: [], criteria: { proven: 0, total: 0 }, verified: { level: "none", proven: 0, total: 0 } },
        { key: "0.3.2", version: "0.3.2", state: "shipped", current: true, issueCount: 4, requirements: [], contents: [], criteria: { proven: 0, total: 0 }, verified: { level: "none", proven: 0, total: 0 } },
      ],
      counts: {},
      approvalRequired: true,
      production: { ok: true, url: "https://api.hop.example" },
      landings: [],
    }),
  ],
  [/\/workflows$/, () => ({ workflows: [], returned: 0 })],
  [/\/workflow-templates$/, () => ({ templates: [] })],
  [/\/config$/, () => ({ declared: true, revision: 1, document: { project: { description: "The clinic back office: patients, bookings and billing over one API." } } })],
  [/\/modules\/rollup$/, () => ({ modules: ["Patients", "Bookings", "Billing"].map((name, i) => ({ id: `m${i}`, name, slug: name.toLowerCase(), parentId: null })) })],
  [/\/steward-budget$/, () => ({ day: NOW, resumesAt: NOW, handoff: { gatewayTurns: { spent: 6, of: 80 }, runnerJobs: { spent: 1, of: 4 } }, sweep: { gatewayTurns: { spent: 2, of: 120 }, runnerJobs: { spent: 0, of: 6 } }, paced: 0, quiet: null })],
  [/^\/memory\/entries$/, () => ({ items: [], counts: { live: 0, superseded: 0, archived: 0 }, returned: 0, total: 0, limit: 100 })],
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname.replace(/^\/api/, "");
  for (const [pattern, answer] of HOME_READS) if (pattern.test(path)) return json(answer());
  if (/\/forecast\/releases\/coming$|\/onboarding$/.test(path)) return json({ error: { code: "NOT_FOUND", message: "none" } }, 404);
  // a read no fixture answers stays in flight, as in the vi walking test
  return new Promise<Response>(() => {});
};

// ── the ops monitor's reads, seeded ──
const OPS_PROJECTS = [
  { id: "p1", slug: "hop", name: "Hop Clinic API", role: "admin", orgId: null },
  { id: "p2", slug: "kho", name: "Warehouse", role: "member", orgId: null },
];
const healthRow = (id: string, name: string, live: number) => ({
  id, projectName: name, projectSlug: name.toLowerCase(), throughput: 12, totalActive: 7, statusDistribution: {}, blockers: [], pendingEscalations: 1,
  avgCycleTimeDays: 2, liveRuns: live, runnerCount: 2, spend24hUsd: 4.2, memberCount: 3, members: [], lastActivityAt: NOW,
});
const OPS_SEED: [QueryKey, unknown][] = [
  [["projects"], OPS_PROJECTS],
  [["projects", "health"], [healthRow("p1", "Hop Clinic API", 2), healthRow("p2", "Warehouse", 0)]],
  [pipelineKeys.stepDurations({ days: 7 }), ["plan", "code", "test", "code"].map((step, i) => ({ runId: `run-${i}`, issueId: null, projectId: i % 2 ? "p2" : "p1", step, startedAt: NOW, finishedAt: NOW, durationSeconds: 600 + i * 300, costUsd: 0.4 + i / 10 }))],
  [pipelineKeys.throughput({ days: 30 }), [{ projectId: "p1", date: day(1), count: 4 }]],
];

/** A fixture list with titles of its own words: the vi fixtures' titles carry their keys ("Muc FB-1"), which would read as a key on the face. */
const titled = (seed: [QueryKey, unknown][], family: string, field: string, names: string[]): [QueryKey, unknown][] =>
  seed.map(([key, value]) => {
    if (key[0] !== family || key.length !== 2) return [key, value];
    const list = value as Record<string, { title: string }[]>;
    return [key, { ...list, [field]: list[field].map((r, i) => ({ ...r, title: names[i % names.length] })) }];
  });
const FEEDBACK_TITLED = titled(FEEDBACK_SEED, "feedback", "feedback", ["Login loops", "Export is empty", "Totals drift", "Slow board", "Wrong date", "Lost draft", "Stale badge", "Bad link"]);
const REQUIREMENTS_TITLED = titled(reqQueries(), "requirements", "requirements", ["Sign-in", "Invoice export"]);

const ISSUE_TITLED: [QueryKey, unknown][] = detailQueries().map(([key, value]) =>
  key[0] === "issue" && key[1] === "i1" && key.length <= 3 && (value as { displayId?: string }).displayId ? [key, { ...(value as object), title: "Totals drift on export" }] : [key, value],
);

const PAGES = [
  { name: "home", path: "/projects/hop", pattern: "/projects/$slug", render: () => <HomePage /> },
  { name: "issue", path: "/projects/hop/issues/ISS-1", render: () => <Seeded data={ISSUE_TITLED}><IssueDetailScreen projectId="p1" slug="hop" id="i1" /></Seeded> },
  { name: "requirements", path: "/projects/hop/requirements", render: () => <Seeded data={REQUIREMENTS_TITLED}><RequirementsScreen projectId={REQ_PROJECT} slug="hop" /></Seeded> },
  { name: "feedback", path: "/projects/hop/feedback", render: () => <Seeded data={FEEDBACK_TITLED}><FeedbackScreen projectId={FB_P} slug="hop" /></Seeded> },
  { name: "releases", path: "/projects/hop/releases", render: () => <Seeded data={releaseSeed()}><ReleasesScreen projectId={REL_P} slug="hop" /></Seeded> },
  { name: "ops", path: "/ops?tab=runs", pattern: "/ops", render: () => <Seeded data={OPS_SEED}><OpsMonitor /></Seeded> },
] as const;

const Home = HomeRoute.options.component as () => ReactNode;
function HomePage() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } }));
  return (
    <QueryClientProvider client={client}>
      <Home />
    </QueryClientProvider>
  );
}

/** A page that throws is named by the stage that drew it, never read as a page with few words. */
class Caught extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? `${e.message} ${e.stack?.split("\n").slice(1, 4).join(" ") ?? ""}` : String(e) };
  }
  render() {
    return this.state.error ? <p data-witness="threw">{this.state.error}</p> : this.props.children;
  }
}

const replace = window.history.replaceState.bind(window.history);
window.history.replaceState = (data, unused, url) => {
  try {
    replace(data, unused, url);
  } catch {
    /* the page stays at its file:// address; the fixtures read nothing from it */
  }
};

const at: { show: (i: number) => void } = { show: () => {} };

function Shell() {
  const [page, setPage] = useState(0);
  useEffect(() => {
    at.show = setPage;
  });
  const p = PAGES[page] ?? PAGES[0];
  return (
    <InRouter key={p.path} at={p.path} pattern={"pattern" in p ? p.pattern : "/projects/$slug/$"}>
      <TopBarSlotProvider>
        <div className="flex h-dvh overflow-hidden bg-app" data-shell>
          <div className="hidden h-full flex-none border-r border-line bg-surface md:block" style={{ width: 280 }} />
          <div className="flex min-w-0 flex-1 flex-col" data-witness="page" data-witness-page={p.name} data-page>
            <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
            <main className="min-h-0 flex-1 overflow-y-auto" data-witness="main">
              <Caught key={p.name}>{p.render()}</Caught>
            </main>
          </div>
        </div>
      </TopBarSlotProvider>
    </InRouter>
  );
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

window.__witness = {
  cases: [{ name: "wide-1440", width: 1440 }],
  ready: () => Boolean(q("[data-witness=page]")),
  stages: PAGES.flatMap((p, i) =>
    (["light", "dark"] as const).map((t) => ({
      name: `${p.name}-${t}`,
      run: async () => {
        at.show(i);
        theme(t);
        await pause(900);
        if (!q(`[data-witness=page][data-witness-page=${p.name}]`)) return [`the ${p.name} page is not the one drawn`];
        const threw = q("[data-witness=threw]");
        if (threw) return [`the ${p.name} page threw: ${threw.innerText.slice(0, 300)}`];
        if (window.innerHeight !== 900) return [`the window is ${window.innerHeight} px tall, not 900`];
        const { count, words } = firstScreenWords(q("[data-witness=page]") as HTMLElement);
        console.log(`${p.name} ${t}: ${count} words on the first screen`);
        if (count < 15) return [`the ${p.name} page drew ${count} words: it did not draw its screen`];
        return count > MOST_WORDS ? [`the ${p.name} page shows ${count} words on its first screen, over ${MOST_WORDS}; it starts: ${words.slice(0, 40).join(" ")}`] : [];
      },
    })),
  ),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Shell />
  </QueryClientProvider>,
);

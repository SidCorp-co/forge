// Development's Needs you after ISS-686 r2, witnessed as drawn at 1280 and 390 in light and dark:
// the one decisions read, three at a time with "+n more" to Approvals and none the master takes
// (REQ-68 BC-3); a free-text question stating what answers it, whole, in its question (BC-1); and what
// each answer does drawn as text, never only a hover title, so a phone shows it. Nothing scrolls
// sideways and no read is left unanswered.
//
//   pnpm --filter web-v2 witness witness/needs-you-decisions-r2.witness.tsx --out <dir>

import { type NeedsYouDecision, needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DevelopmentOverviewScreen } from "@/features/development/components/development-overview-screen";
import LIVE from "./delivery-holds.fixture.json";
import "./entry";
import { InRouter } from "./router";

const P = "p-delivery";
const NEED =
  "Which of two ways on: a second fix round on c1, where the trace advice on the wrong branch is rewritten and re-judged, or accept c1 as it stands, since the advice is right on every branch a person reads and only the internal one is off.";
const Q = (n: number) => `0000000${n}-0000-4000-8000-000000000673`;

const question = (n: number, over: Partial<NeedsYouDecision> = {}): NeedsYouDecision => ({
  id: `question:${Q(n)}`,
  group: "answer",
  area: "issues",
  entity: "issue",
  key: `ISS-67${n}`,
  title: `Trace advice round ${n}`,
  opens: { kind: "issue", key: `ISS-67${n}` },
  question: `The judge failed c1 of ISS-67${n}. How should the run go on?\n\nWhat answers it: ${NEED}`,
  changes: `What the run that asked on ISS-67${n} goes on with`,
  impact: `ISS-67${n} waits on this; it goes on once it has your answer.`,
  recommended: { answerId: "recommended", why: "Whoever asked recommends: accept c1 as it stands.", by: "asker" },
  noRecommendation: null,
  answers: [
    { id: "recommended", label: "Send the recommended answer", act: "question.answer", path: `/api/questions/${Q(n)}/answer`, body: { round: 1, text: "Accept c1 as it stands." }, needsReason: false, declines: false, effect: "Sends the recommended answer to the run that asked.", recommended: true },
    { id: "write", label: "Write another answer", act: "question.answer", path: `/api/questions/${Q(n)}/answer`, body: { round: 1 }, needsReason: true, declines: false, effect: "Sends what you write to the run that asked.", recommended: false },
  ],
  touchedAt: `2026-10-2${n}T09:00:00.000Z`,
  stuck: false,
  dueAt: null,
  topic: "question",
  proposal: null,
  ...over,
});

const READ = needsYouDecisionsSchema.parse({
  generatedAt: "2026-10-26T06:00:00.000Z",
  decisions: [1, 2, 3, 4, 5].map((n) => question(n)),
  total: 5,
  notDecisions: [{ reason: "agent_takes", count: 7, items: [{ key: "FB-277", title: "FB-277", next: "the master takes it", opens: { kind: "feedback", key: "FB-277" } }] }],
});

const unanswered = new Set<string>();
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://forge.test").pathname.replace(/^\/api/, "");
  if (path === `/projects/${P}/development/overview`) return json(LIVE);
  if (path === `/projects/${P}/needs-you`) return json({ items: [] });
  if (path === `/projects/${P}/needs-you/decisions`) return json(READ);
  const empty: Record<string, unknown> = {
    "/agent-sessions/queue-stats": { devices: [] },
    [`/projects/${P}/runners`]: [],
    "/runners/active": { runners: [], busy: 0, total: 0 },
    "/projects/health": [],
    [`/projects/${P}/pipeline-runs`]: { items: [], total: 0, returned: 0, limit: 200, offset: 0, hasMore: false },
    "/pipeline/step-durations": [],
    [`/projects/${P}/issues/search`]: { items: [], totalCount: 0 },
  };
  if (path in empty) return json(empty[path]);
  if (path === `/projects/${P}/forecast/releases/draft`) return new Response(JSON.stringify({ code: "NOT_FOUND", message: "no draft" }), { status: 404 });
  unanswered.add(`${init?.method ?? "GET"} ${path}`);
  return new Promise<Response>(() => {});
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })}>
    <InRouter at="/projects/hop/development" pattern="/projects/$slug/development">
      <div className="min-h-dvh bg-app" data-witness="page">
        <DevelopmentOverviewScreen scope={{ projectId: P, slug: "hop" }} />
      </div>
    </InRouter>
  </QueryClientProvider>,
);

const section = () => document.querySelector<HTMLElement>("[data-testid=needs-you]");
const text = () => section()?.innerText ?? "";
const has = (needle: string) => (text().includes(needle) ? [] : [`"${needle}" is not drawn in Needs you`]);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const rows = () => section()?.querySelectorAll("[data-testid=needs-you-decision]") ?? [];
const checks = () => [
  ...(rows().length === 3 ? [] : [`${rows().length} decisions are drawn, not three`]),
  ...has("+2 more"),
  ...has(`What answers it: ${NEED}`),
  ...has("Write another answer: Sends what you write to the run that asked."),
  ...(text().includes("FB-277") ? ["a decision the master takes is drawn as yours"] : []),
  ...[...unanswered].map((r) => `core was sent ${r} and nothing answers it`),
  ...(document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : []),
];

window.__witness = {
  cases: [
    { name: "desktop", width: 1280 },
    { name: "phone", width: 390 },
  ],
  ready: () => rows().length > 0,
  stages: (["light", "dark"] as const).map((t) => ({
    name: `needs-you-${t}`,
    run: async () => {
      theme(t);
      section()?.scrollIntoView();
      await pause(300);
      return checks();
    },
  })),
};

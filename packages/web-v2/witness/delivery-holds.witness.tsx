// The Delivery page's Held section (ISS-684, REQ-74 BC-4, BC-5), drawn over the overview core itself
// served (`delivery-holds.fixture.json`, read off `GET /development/overview` in an integration run
// seeded with a self-clearing job hold, a held job, a failed run, a blocked run and a release hold).
// Each hold names its cause and who acts next, per issue and per release, at 1440 and 390 in light
// and dark; nothing scrolls sideways and no read is left unanswered.
//
//   pnpm --filter web-v2 witness witness/delivery-holds.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DevelopmentOverviewScreen } from "@/features/development/components/development-overview-screen";
import LIVE from "./delivery-holds.fixture.json";
import "./entry";
import { InRouter } from "./router";

const P = "p-delivery";
const unanswered = new Set<string>();
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://forge.test").pathname.replace(/^\/api/, "");
  if (path === `/projects/${P}/development/overview`) return json(LIVE);
  if (path === `/projects/${P}/needs-you`) return json({ items: [] });
  // the activity below the held list, read empty: this witness is about the holds
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

const page = () => document.querySelector<HTMLElement>("[data-witness=page]");
const text = () => page()?.innerText ?? "";
const has = (needle: string) => (text().includes(needle) ? [] : [`"${needle}" is not drawn`]);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const settled = () => [
  ...[...unanswered].map((r) => `core was sent ${r} and nothing answers it`),
  ...(document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : []),
];
const CODE = /[a-z]+_[a-z_]+|[A-Z]{3,}_[A-Z_]+/;
const coded = () =>
  [...document.querySelectorAll<HTMLElement>("[data-testid=hold-cause]")].flatMap((c) => (CODE.test(c.innerText) ? [`a cause line shows a code: "${c.innerText}"`] : []));
const byIssue = () => [
  ...has("Held"),
  ...has("Hit the model provider's usage limit"),
  ...has("No runner has checked in recently"),
  ...has("Every runner was busy; it retries by itself"),
  ...has("Retried too many times; it will not resume itself"),
  ...has("No runner serving this project is online"),
  ...has("The runner's owner"),
  ...has("bring a runner online"),
  ...has("resume it when the wait ends"),
  ...has("by "),
  ...coded(),
  ...(document.querySelectorAll("[data-testid=delivery-hold]").length === 5 ? [] : ["five holds are not drawn by issue"]),
];
const byRelease = () => [
  ...has("Release 0.1.0"),
  ...(document.querySelector("[data-testid=delivery-hold]")?.textContent?.includes("ISS-6") ? [] : ["the release hold does not name its issue"]),
  ...(document.querySelectorAll("[data-testid=delivery-hold]").length === 1 ? [] : ["the release view does not draw the one release hold alone"]),
];
const toggle = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(label))?.click();

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => Boolean(document.querySelector("[data-testid=delivery-holds]")),
  stages: (["light", "dark"] as const).flatMap((t) => [
    {
      name: `by-issue-${t}`,
      run: async () => {
        theme(t);
        toggle("By issue");
        await pause(400);
        return [...byIssue(), ...settled()];
      },
    },
    {
      name: `by-release-${t}`,
      run: async () => {
        toggle("By release");
        await pause(400);
        return [...byRelease(), ...settled()];
      },
    },
  ]),
};

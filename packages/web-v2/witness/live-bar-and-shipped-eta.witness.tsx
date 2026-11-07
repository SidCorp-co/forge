// ISS-1102 and ISS-1103 as a person sees them: the Feedback list in the shell, the project bar on top.
// The bar reads the live runs with the leased builds core serves beside them (a direct-mode master's
// builds, no run record), and the list's ETA cell reads a Planned item whose carrier shipped while
// its judgement is owed. `VITE_WITNESS_BEFORE=1` draws the same page from the facts core gave before
// either fix (no leased builds, nothing owed): the bar says "Nothing running" beside builds in
// progress and the cell says "Shipped" alone beside Planned. Each stage prints
// `WORDS <stage> <width> <n>` and is shot to `<out>/<case>-<theme>.png`.
//
//   [VITE_WITNESS_BEFORE=1] pnpm --filter web-v2 witness witness/live-bar-and-shipped-eta.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { LiveBar } from "@/features/agents";
import type { MasterStanding, RunLeasedBuild, RunStandingList } from "@/features/agents/types";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { feedbackForecastKey } from "@/features/forecast/hooks";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { P } from "@/test/vi-chrome-feedback";
import { Seeded } from "@/test/vi-chrome-requirements";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";
import { Caught, FEEDBACK_TITLED } from "./screens.fixture";

const BEFORE = import.meta.env.VITE_WITNESS_BEFORE === "1";
const NOW = Date.now();
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

const replace = window.history.replaceState.bind(window.history);
window.history.replaceState = (data, unused, url) => {
  try {
    replace(data, unused, url);
  } catch {
    /* the page stays at its file:// address; the fixtures read nothing from it */
  }
};

const master = {
  generatedAt: ago(0),
  projectId: P,
  state: "idle",
  sessionId: "m1",
  name: "forge-master-forge",
  device: { id: "d1", name: "box-1" },
  since: null,
  pass: null,
  passIssueTitle: null,
  lastPass: { endedAt: ago(40) },
  slots: null,
  runsOut: 0,
  lastBeatAt: ago(0),
  silentAfterSeconds: 600,
  waitingOn: null,
  dialogsAnswered: null,
  pane: null,
  outdated: null,
} as unknown as MasterStanding;

const build = (key: string, title: string, minutes: number): RunLeasedBuild => ({
  issue: { key, title, status: "in_progress" },
  step: "build",
  stepStartedAt: ago(minutes),
  holder: "forge-master-box-1",
  byMaster: true,
  expiresAt: ago(-240),
});

const LEASED = [
  build("ISS-1101", "A chat session keeps the checkout it was created with", 17),
  build("ISS-1100", "An owed delivery check waits until the next UTC day", 19),
  build("ISS-1070", "The app shell loads attention on every route", 34),
];

const live = { items: [], master, leased: BEFORE ? [] : LEASED } as unknown as RunStandingList;
const recent = { items: [], master, leased: [] } as unknown as RunStandingList;

const shippedLine = {
  key: "FB-3",
  triage: null,
  delivery: {
    label: "forecast",
    asOf: ago(0),
    landing: { label: "forecast", asOf: ago(0), kind: "landed", landedAt: ago(2 * 1440) },
    release: null,
    inHands: null,
    shipped: { version: "0.4.0-dev.532", at: ago(2 * 1440 - 20) },
  },
  owes: BEFORE ? null : "judgement",
};

const DATA: [QueryKey, unknown][] = [
  ...FEEDBACK_TITLED.map(([k, v]): [QueryKey, unknown] => (JSON.stringify(k) === JSON.stringify(feedbackForecastKey(P)) ? [k, { projectId: P, items: [shippedLine] }] : [k, v])),
  [["runs-standing", P, "list", "live"], live],
  [["runs-standing", P, "recent"], recent],
  [["support-turns", P], { generatedAt: ago(0), projectId: P, rooms: [] }],
];

function Page() {
  return (
    <InRouter at="/projects/hop/feedback" pattern="/projects/$slug/$">
      <TopBarSlotProvider>
        <div className="flex h-dvh overflow-hidden bg-app" data-shell>
          <div className="flex min-w-0 flex-1 flex-col" data-witness="page" data-page>
            <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
            <main className="min-h-0 flex-1 overflow-y-auto" data-witness="main">
              <Caught>
                <Seeded data={DATA}>
                  <LiveBar projectId={P} slug="hop" />
                  <FeedbackScreen projectId={P} slug="hop" />
                </Seeded>
              </Caught>
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

/** What each fix promises, read off the page drawn; BEFORE answers the defect it shows instead. */
function probe(): string[] {
  const out: string[] = [];
  const bar = q("[data-testid=live-bar]");
  if (!bar) return ["the project bar is not drawn"];
  const nothing = Boolean(q("[data-testid=live-bar-nothing]"));
  if (BEFORE !== nothing) out.push(`the bar ${nothing ? "says nothing runs" : "names a build"} (${bar.innerText.slice(0, 120)})`);
  const cells = [...document.querySelectorAll<HTMLElement>("[data-testid=eta-cell]")];
  const judging = cells.some((c) => c.dataset.kind === "judging" && c.innerText.includes("Awaiting judgement"));
  if (BEFORE === judging) out.push(`the shipped cell ${judging ? "says judgement is owed" : "says shipped alone"}`);
  if (bar.innerText.includes("forge-master-box-1") || /ISS-\d/.test(bar.innerText)) out.push("the bar carries a code on its face");
  return out;
}

window.__witness = {
  cases: [
    { name: "wide-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(q("[data-testid=live-bar]") && q("[data-testid=eta-cell]")),
  stages: (["light", "dark"] as const).map((t) => ({
    name: t,
    run: async () => {
      theme(t);
      await pause(900);
      const threw = q("[data-witness=threw]");
      if (threw) return [`the page threw: ${threw.innerText.slice(0, 300)}`];
      const { count, words } = firstScreenWords(q("[data-witness=page]") as HTMLElement);
      console.log(`WORDS ${BEFORE ? "before" : "after"}-${t} ${window.innerWidth} ${count} :: ${words.slice(0, 80).join(" ")}`);
      return probe();
    },
  })),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Page />
  </QueryClientProvider>,
);

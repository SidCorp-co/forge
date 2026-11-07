// The UI-E residuals of ISS-1109 as a person sees them, from forge-core-61's live QA on dev.583: the
// Feedback list under the project bar, the bar opened, and a feedback item's page. jsdom lays nothing
// out, so each defect only a width shows is read here, in headless Chrome:
//   4. on a phone, a shipped cell's "Awaiting judgement" starts under "Shipped …", not indented to its right edge;
//   5. on a phone, an item's tabs stand on one line beside Properties, and the opened bar keeps each age on its item's line;
//   6. a New row's ETA does not say again whose turn it is, which Waiting on says, and on a phone its
//      wait keeps a gap before the owner chip.
// Each stage prints `WORDS <stage> <width> <n>` and is shot to `<out>/<case>-<stage>.png`.
//
//   pnpm --filter web-v2 witness witness/uie-residuals.witness.tsx --out <dir>

import type { FeedbackForecast } from "@forge/contracts/forecast";
import { say } from "@forge/contracts/said";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { LiveBar } from "@/features/agents";
import type { MasterStanding, RunLeasedBuild, RunStandingList } from "@/features/agents/types";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { feedbackForecastKey } from "@/features/forecast/hooks";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { P, SCREENS as FEEDBACK_SCREENS } from "@/test/vi-chrome-feedback";
import { Seeded } from "@/test/vi-chrome-requirements";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";
import { Caught, FEEDBACK_TITLED } from "./screens.fixture";

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

const build = (n: number, title: string, minutes: number): RunLeasedBuild => ({
  issue: { key: `ISS-${n}`, title, status: "in_progress" },
  step: "build",
  stepStartedAt: ago(minutes),
  holder: "forge-master-box-1",
  byMaster: true,
  expiresAt: ago(-240),
});

const LEASED = [
  build(1101, "The room screener reads any PREFIX-digits token as an issue key", 3),
  build(1100, "support.thread returns messages without their ids, so a channel agent cannot cite one", 4),
  build(1099, "A room's held turns wait behind a broken session for hours", 50),
  build(1098, "A master post cannot mention a thread's real asker", 55),
  build(1097, "A requirement's owed check and breakdown read as starting on their SLA date", 31),
];

const live = { items: [], master, leased: LEASED } as unknown as RunStandingList;
const recent = { items: [], master, leased: [] } as unknown as RunStandingList;

const triage = (key: string): FeedbackForecast => ({
  key,
  triage: {
    label: "forecast",
    asOf: ago(0),
    kind: "paused",
    who: "The project's master",
    act: "triage it",
    reason: "untriaged",
    says: { who: say("standing.who.projectMaster"), act: say("standing.act.triageIt"), reason: say("standing.act.triageIt") },
    ref: null,
    since: ago(20),
    late: null,
  },
  delivery: null,
  owes: null,
} as unknown as FeedbackForecast);

const shipped = (key: string): FeedbackForecast => ({
  key,
  triage: null,
  delivery: {
    label: "forecast",
    asOf: ago(0),
    landing: { label: "forecast", asOf: ago(0), kind: "landed", landedAt: ago(2 * 1440) },
    release: null,
    inHands: null,
    shipped: { version: "0.4.0-dev.532", at: ago(2 * 1440 - 20) },
  },
  owes: "judgement",
} as unknown as FeedbackForecast);

const FORECASTS = { projectId: P, items: [triage("FB-1"), triage("FB-7"), shipped("FB-3")] };
const DATA: [QueryKey, unknown][] = [
  ...FEEDBACK_TITLED.map(([k, v]): [QueryKey, unknown] => (JSON.stringify(k) === JSON.stringify(feedbackForecastKey(P)) ? [k, FORECASTS] : [k, v])),
  [["runs-standing", P, "list", "live"], live],
  [["runs-standing", P, "recent"], recent],
  [["support-turns", P], { generatedAt: ago(0), projectId: P, rooms: [] }],
];

const detail = FEEDBACK_SCREENS.find((s) => s.name === "Feedback detail");
if (!detail) throw new Error('the vi screens carry no "Feedback detail"');

const at: { show: (page: "list" | "detail") => void } = { show: () => {} };

function Page() {
  const [page, setPage] = useState<"list" | "detail">("list");
  useEffect(() => {
    at.show = setPage;
  });
  return (
    <InRouter key={page} at={page === "list" ? "/projects/hop/feedback" : "/projects/hop/feedback/FB-2"} pattern="/projects/$slug/$">
      <TopBarSlotProvider>
        <div className="flex h-dvh overflow-hidden bg-app" data-shell>
          <div className="flex min-w-0 flex-1 flex-col" data-witness="page" data-page>
            <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
            <main className="min-h-0 flex-1 overflow-y-auto" data-witness="main">
              <Caught>
                <Seeded data={DATA}>
                  <LiveBar projectId={P} slug="hop" />
                  {page === "list" ? <FeedbackScreen projectId={P} slug="hop" /> : detail?.render()}
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
const all = (sel: string, from: ParentNode = document) => [...from.querySelectorAll<HTMLElement>(sel)];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const phone = () => window.innerWidth < 768;
const box = (el: Element) => el.getBoundingClientRect();
/** Two boxes on one line: their vertical middles inside each other. */
const sameLine = (a: Element, b: Element) => {
  const ra = box(a);
  const rb = box(b);
  const mid = rb.top + rb.height / 2;
  return mid > ra.top && mid < ra.bottom;
};

/** Residuals 4 and 6, read off the list. */
function listWrong(): string[] {
  const out: string[] = [];
  if (document.documentElement.scrollWidth > window.innerWidth) out.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  const rows = all("[data-testid=list-row]");
  if (rows.length === 0) return ["the list drew no rows"];
  for (const row of rows) {
    const key = row.dataset.key;
    const eta = row.querySelector<HTMLElement>("[data-testid=eta-cell]");
    // 6: a New row's turn is its Waiting on's; the ETA does not say it again
    if (eta?.dataset.kind === "waits") out.push(`${key}'s ETA says again whose turn it is: "${eta.innerText.trim()}"`);
    // 4: on a phone the judgement owed starts where the shipped line starts
    const line = eta?.querySelector<HTMLElement>("[data-testid=eta-line]");
    const also = eta?.querySelector<HTMLElement>("[data-testid=eta-also]");
    if (phone() && line && also && Math.abs(box(line).left - box(also).left) > 1)
      out.push(`${key}'s "${also.innerText.trim()}" starts at ${Math.round(box(also).left)} px, not under "${line.innerText.trim()}" at ${Math.round(box(line).left)} px`);
    // 6: on a phone the wait keeps a gap before the owner chip
    const wait = row.querySelector<HTMLElement>("[data-testid=waiting-on]");
    const owner = row.querySelector<HTMLElement>("[data-testid=list-row] > span:last-child");
    if (phone() && wait && owner && owner.innerText.trim() && sameLine(wait, owner)) {
      const gap = box(owner).left - box(wait).right;
      if (gap < 6) out.push(`${key}'s wait "${wait.innerText.trim()}" runs into its owner "${owner.innerText.trim()}" (${Math.round(gap)} px apart)`);
    }
  }
  return out;
}

/** Residual 5, the bar opened: each item's age stays on its item's line. */
function barWrong(): string[] {
  const list = q("[data-testid=live-bar-list]");
  if (!list) return ["the bar did not open"];
  const out: string[] = [];
  for (const li of all("li", list)) {
    const link = li.querySelector("a");
    const age = li.querySelector(":scope > span.tabular-nums");
    if (link && age && !sameLine(link, age)) out.push(`the opened bar's age "${age.textContent}" wraps under "${(link.textContent ?? "").slice(0, 40)}"`);
  }
  return out;
}

/** Residual 5, the item's page: its tabs stand on one line, beside Properties. */
function tabsWrong(): string[] {
  const bar = q("[data-testid=feedback-tabs]");
  if (!bar) return ["the item drew no tabs"];
  const tabs = all("[role=tab]", bar);
  if (tabs.length < 3) return [`the item drew ${tabs.length} tabs, not its three`];
  const first = tabs[0];
  const out = tabs.filter((t) => !sameLine(first, t)).map((t) => `the "${t.innerText.trim()}" tab drops to a second line`);
  const props = q("[data-testid=feedback-properties]");
  if (!props) out.push("the item has no Properties to open");
  else if (!sameLine(first, props)) out.push("Properties stands on a line of its own");
  if (props && (props.getAttribute("aria-label") ?? props.innerText).trim() !== "Properties") out.push(`Properties is named "${props.getAttribute("aria-label") ?? props.innerText}" to a screen reader`);
  return out;
}

const words = (stage: string) => {
  const { count, words: w } = firstScreenWords(q("[data-witness=page]") as HTMLElement);
  console.log(`WORDS ${stage} ${window.innerWidth} ${count} :: ${w.slice(0, 80).join(" ")}`);
};

const threw = () => {
  const t = q("[data-witness=threw]");
  return t ? [`the page threw: ${t.innerText.slice(0, 300)}`] : null;
};

window.__witness = {
  cases: [
    { name: "wide-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(q("[data-testid=live-bar]") && q("[data-testid=eta-cell]")),
  stages: (["light", "dark"] as const).flatMap((t) => [
    {
      name: `list-${t}`,
      run: async () => {
        at.show("list");
        theme(t);
        await pause(900);
        words(`list-${t}`);
        return threw() ?? listWrong();
      },
    },
    {
      name: `bar-open-${t}`,
      run: async () => {
        const open = all("[data-testid=live-bar] button").find((b) => b.getAttribute("aria-expanded") === "false");
        open?.click();
        await pause(400);
        words(`bar-open-${t}`);
        // left open for its shot; the next stage draws the page anew
        return threw() ?? barWrong();
      },
    },
    {
      name: `detail-${t}`,
      run: async () => {
        at.show("detail");
        await pause(1100);
        words(`detail-${t}`);
        return threw() ?? tabsWrong();
      },
    },
  ]),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Page />
  </QueryClientProvider>,
);

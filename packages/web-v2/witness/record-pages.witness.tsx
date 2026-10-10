// A record page's first screen (REQ-43 BC-3): the issue, requirement, feedback item, release, run,
// session, workflow design, contract and agent report pages, each in the shell as app/(workspace)/layout.tsx draws it, at 1440 by 900. Every stage counts the
// words a person sees before scrolling — the top bar the page puts its header in and the page under
// it — and fails a page over 300.
//
//   pnpm --filter web-v2 witness witness/record-pages.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { TopBarSlotProvider } from "@/design";
import type { ChromeScreen } from "@/test/vi-chrome-screens";
import { SCREENS as AGENT_SCREENS } from "@/test/vi-chrome-agents";
import { SCREENS as AUTOMATION_SCREENS } from "@/test/vi-chrome-automation";
import { SCREENS as CONTRACT_SCREENS } from "@/test/vi-chrome-contracts";
import { SCREENS as FEEDBACK_SCREENS } from "@/test/vi-chrome-feedback";
import { SCREENS as ISSUE_SCREENS } from "@/test/vi-chrome-issues";
import { SCREENS as RELEASE_SCREENS } from "@/test/vi-chrome-rel-wf";
import { SCREENS as REQUIREMENT_SCREENS } from "@/test/vi-chrome-requirements";
import { SCREENS as SESSION_SCREENS } from "@/test/vi-chrome-sessions";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";

/** REQ-43 BC-3: the most words a record page's first screen shows. */
const MOST_WORDS = 300;

// the fixtures' own pages set the query string with replaceState, which a file:// page refuses for a path
const replace = window.history.replaceState.bind(window.history);
window.history.replaceState = (data, unused, url) => {
  try {
    replace(data, unused, url);
  } catch {
    /* the page stays at its file:// address; the fixtures read nothing from it */
  }
};
// a read no fixture seeded stays in flight, as in the vi walking test
window.fetch = () => new Promise<Response>(() => {});

const named = (screens: ChromeScreen[], name: string | RegExp): ChromeScreen => {
  const hit = screens.find((s) => (typeof name === "string" ? s.name === name : name.test(s.name)));
  if (!hit) throw new Error(`no fixture screen is named "${name}"`);
  return hit;
};

const PAGES = [
  { name: "issue", path: "/projects/hop/issues/ISS-1", screen: named(ISSUE_SCREENS, "Issue detail") },
  { name: "requirement", path: "/projects/hop/requirements/REQ-1", screen: named(REQUIREMENT_SCREENS, "Requirement detail · Overview") },
  { name: "feedback", path: "/projects/hop/feedback/FB-2", screen: named(FEEDBACK_SCREENS, "Feedback detail") },
  { name: "release", path: "/projects/hop/releases/0.0.9", screen: named(RELEASE_SCREENS, "Release detail") },
  { name: "run", path: "/projects/hop/agents/runs/r5", screen: named(AGENT_SCREENS, /^Run page · \S+ 5$/) },
  { name: "session-run", path: "/projects/hop/agents/s-run", screen: named(SESSION_SCREENS, "Session · run report") },
  { name: "session-chat", path: "/projects/hop/agents/s-chat", screen: named(SESSION_SCREENS, "Session · chat") },
  { name: "workflow", path: "/projects/hop/workflows/onboarding", screen: named(RELEASE_SCREENS, "Workflow design") },
  { name: "contract", path: "/projects/hop/contracts/hop/orders", screen: named(CONTRACT_SCREENS, "Contract detail") },
  { name: "report", path: "/projects/hop/automation/reports/a-report-0001", screen: named(AUTOMATION_SCREENS, "Automation · report page") },
] as const;

const at: { show: (i: number) => void } = { show: () => {} };

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

function Shell() {
  const [page, setPage] = useState(0);
  useEffect(() => {
    at.show = setPage;
  });
  const p = PAGES[page] ?? PAGES[0];
  return (
    <InRouter key={p.path} at={p.path} pattern="/projects/$slug/$">
      <TopBarSlotProvider>
        <div className="flex h-dvh overflow-hidden bg-app" data-shell>
          <div className="hidden h-full flex-none border-r border-line bg-surface md:block" style={{ width: 280 }} />
          <div className="flex min-w-0 flex-1 flex-col" data-witness="page" data-witness-page={p.name} data-page>
            <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
            <main className="min-h-0 flex-1 overflow-y-auto" data-witness="main">
              <Caught key={p.name}>{p.screen.render()}</Caught>
            </main>
          </div>
        </div>
      </TopBarSlotProvider>
    </InRouter>
  );
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

window.__witness = {
  cases: [{ name: "wide-1440", width: 1440 }],
  ready: () => Boolean(q("[data-witness=page]")),
  stages: PAGES.map((p, i) => ({
    name: p.name,
    run: async () => {
      at.show(i);
      await pause(600);
      if (!q(`[data-witness=page][data-witness-page=${p.name}]`)) return [`the ${p.name} page is not the one drawn`];
      const threw = q("[data-witness=threw]");
      if (threw) return [`the ${p.name} page threw: ${threw.innerText.slice(0, 300)}`];
      const column = q("[data-witness=page]") as HTMLElement;
      if (window.innerHeight !== 900) return [`the window is ${window.innerHeight} px tall, not 900`];
      const { count, words } = firstScreenWords(column);
      console.log(`${p.name}: ${count} words on the first screen`);
      if (count < 20) return [`the ${p.name} page drew ${count} words: it did not draw its record`];
      return count > MOST_WORDS ? [`the ${p.name} page shows ${count} words on its first screen, over ${MOST_WORDS}; it starts: ${words.slice(0, 40).join(" ")}`] : [];
    },
  })),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Shell />
  </QueryClientProvider>,
);

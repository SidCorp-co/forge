// The six screens REQ-11 BC-18..BC-21 judge — project home, an issue, requirements, feedback,
// releases and ops — each in the shell at 1440 by 900, in light then dark. Every stage counts the
// words a person sees before scrolling (witness/first-screen.ts) and fails a screen over 300.
//
//   pnpm --filter web-v2 witness witness/screens-act.witness.tsx --out <dir>

import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TopBarSlotProvider } from "@/design";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { IssueDetailScreen } from "@/features/issues/components/issue-detail-screen";
import { OpsMonitor } from "@/features/pipeline";
import { ReleasesScreen } from "@/features/releases/components/releases-screen";
import { RequirementsScreen } from "@/features/requirements/components/requirements-screen";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { P as FB_P } from "@/test/vi-chrome-feedback";
import { P as REL_P, releaseSeed } from "@/test/vi-chrome-rel-wf";
import { REQ_PROJECT, Seeded } from "@/test/vi-chrome-requirements";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";
import { Caught, FEEDBACK_TITLED, HomePage, ISSUE_TITLED, OPS_SEED, REQUIREMENTS_TITLED } from "./screens.fixture";


/** REQ-11 BC-21: the most words a screen's first view shows. */
const MOST_WORDS = 300;

const PAGES = [
  { name: "home", path: "/projects/hop", pattern: "/projects/$slug", render: () => <HomePage /> },
  { name: "issue", path: "/projects/hop/issues/ISS-1", render: () => <Seeded data={ISSUE_TITLED}><IssueDetailScreen projectId="p1" slug="hop" id="i1" /></Seeded> },
  { name: "requirements", path: "/projects/hop/requirements", render: () => <Seeded data={REQUIREMENTS_TITLED}><RequirementsScreen projectId={REQ_PROJECT} slug="hop" /></Seeded> },
  { name: "feedback", path: "/projects/hop/feedback", render: () => <Seeded data={FEEDBACK_TITLED}><FeedbackScreen projectId={FB_P} slug="hop" /></Seeded> },
  { name: "releases", path: "/projects/hop/releases", render: () => <Seeded data={releaseSeed()}><ReleasesScreen projectId={REL_P} slug="hop" /></Seeded> },
  // Ops opens on its Monitor tab; the stage then opens Runs, the tab whose rows this change reads
  { name: "ops", path: "/ops", pattern: "/ops", render: () => <Seeded data={OPS_SEED}><OpsMonitor /></Seeded>, tab: "Runs" },
] as const;


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
        if ("tab" in p) {
          const tab = [...document.querySelectorAll<HTMLElement>("[role=tab],button")].find((b) => b.textContent?.trim() === p.tab);
          if (!tab) return [`the ${p.name} page has no ${p.tab} tab to open`];
          tab.click();
          await pause(500);
        }
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

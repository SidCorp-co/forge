// The module map witnessed in the workspace shell (ISS-1256, mockup MK-11): the pillar, a module's
// tree with the rail of the term Run slots, and the ⌘K search for "chia slot", each at 1440 and 390 px
// in light and dark. Each stage prints its first screen's words; a probe names what the map must show:
// the Unplaced row, a count opening its tree at its branch, the rail's relations, the term found first
// by its other name, and no page scrolling sideways.
//
//   pnpm --filter web-v2 witness witness/module-map.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BottomTabBar, CommandPalette, PageCommandsProvider, TopBarSlotProvider } from "@/design";
import { FindResults, ModuleMapScreen, ModuleTreeScreen } from "@/features/modules";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { bottomTabItems } from "@/features/shell/nav-model";
import { FIND_CHIA_SLOT, MAP_PROJECT as P, PILLAR, TREE } from "@/test/module-map";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const GAPS = { projectId: P, window: { days: 30, since: "2026-10-17" }, gaps: [{ query: "steward budget", searches: 3, firstAt: "", lastAt: "", lastBy: "agent" }, { query: "run quota", searches: 1, firstAt: "", lastAt: "", lastBy: "person" }] };
window.sessionStorage.clear();
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname.replace(/^\/api/, "");
  if (path === `/projects/${P}/modules/map`) return json(PILLAR);
  if (path === `/projects/${P}/modules/execution/map`) return json(TREE);
  if (path === `/projects/${P}/find`) return json(FIND_CHIA_SLOT);
  if (path === `/projects/${P}/find/gaps`) return json(GAPS);
  return new Promise<Response>(() => {});
};

type View = "pillar" | "tree" | "search";
const show: { view: (v: View) => void } = { view: () => {} };
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const phone = window.innerWidth < 768;
const noop = () => {};
const address = (search: string) => window.history.replaceState(null, "", `${window.location.pathname}${search}`);

function Page() {
  const [view, setView] = useState<View>("pillar");
  show.view = setView;
  return (
    <>
      {view === "tree" ? <ModuleTreeScreen projectId={P} slug="hop" moduleSlug="execution" /> : <ModuleMapScreen projectId={P} slug="hop" />}
      {view === "search" ? (
        <CommandPalette open onClose={noop} commands={[]} initialQuery="chia slot" search={(q, close) => <FindResults projectId={P} slug="hop" query={q} onClose={close} />} />
      ) : null}
    </>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/modules" pattern="/projects/$slug/modules">
    <QueryClientProvider client={client}>
      <TopBarSlotProvider>
        <PageCommandsProvider openPalette={noop} searchPalette={noop}>
          <div className="flex h-dvh overflow-hidden bg-shell" data-shell>
            {phone ? null : <div className="h-full flex-none border-r border-line bg-surface" style={{ width: 280 }} />}
            <div className="flex min-w-0 flex-1 flex-col" data-page data-witness="page">
              <ShellTopBar chatOpen={false} onToggleChat={noop} />
              <main className="min-h-0 flex-1 overflow-y-auto bg-app pb-[calc(56px+env(safe-area-inset-bottom))] window-md:pb-0" data-witness="main">
                <div className="flex min-h-full min-w-0 flex-col">
                  <Page />
                </div>
              </main>
            </div>
            <BottomTabBar items={bottomTabItems(4)} activeKey="home" onSelect={noop} />
          </div>
        </PageCommandsProvider>
      </TopBarSlotProvider>
    </QueryClientProvider>
  </InRouter>,
);

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const width = phone ? "390" : "1440";

function words(stage: string, root: HTMLElement | null): string[] {
  if (!root) return [`${stage}: nothing to count`];
  const { count, words: w } = firstScreenWords(root);
  console.log(`WORDS module-map-${stage}-${width} ${count} :: ${w.slice(0, 200).join(" ")}`);
  return [];
}

const sideways = () => (document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : []);

function pillar(): string[] {
  const wrong: string[] = [];
  if (!q("[data-testid=pillar-unplaced]")) wrong.push("no Unplaced row");
  const rule = q("[data-testid=pillar-row] [data-testid=pillar-count][data-branch=rule]");
  if (rule?.getAttribute("href") !== "/projects/hop/modules/execution?type=rule") wrong.push(`Execution's rules open ${rule?.getAttribute("href")}`);
  return wrong;
}

function tree(): string[] {
  const wrong: string[] = [];
  const rail = q("[data-testid=node-rail]");
  if (rail?.dataset.node !== "term:run-slots") wrong.push(`the rail shows ${rail?.dataset.node}`);
  for (const kind of ["used_in.out", "from.out", "anchored_at.out"]) if (!q(`[data-testid="rail-${kind}"]`)) wrong.push(`the rail draws no ${kind}`);
  return wrong;
}

function search(): string[] {
  const first = q("[data-testid=find-hit]");
  return first?.textContent?.includes("Run slots") ? [] : [`the first hit is ${first?.textContent?.slice(0, 40)}`];
}

const dialog = () => q("[role=dialog]");

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390, height: 844 },
  ],
  ready: () => document.querySelectorAll("[data-testid=pillar-row]").length > 0,
  stages: [
    { name: "pillar-light", run: async () => (theme("light"), await settle(900), [...sideways(), ...pillar(), ...words("pillar", q("[data-witness=page]"))]) },
    { name: "pillar-dark", run: async () => (theme("dark"), await settle(), sideways()) },
    { name: "tree-light", run: async () => (theme("light"), address("?node=term%3Arun-slots"), show.view("tree"), await settle(900), [...sideways(), ...tree(), ...words("tree", q("[data-witness=page]"))]) },
    { name: "tree-dark", run: async () => (theme("dark"), await settle(), sideways()) },
    { name: "search-light", run: async () => (theme("light"), address(""), show.view("search"), await settle(1200), [...search(), ...words("search", dialog())]) },
    { name: "search-dark", run: async () => (theme("dark"), await settle(), search()) },
  ],
};

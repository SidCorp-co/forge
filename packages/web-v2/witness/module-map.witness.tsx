// The module map witnessed in the workspace shell (ISS-1256, mockup MK-11): the pillar, a module's
// tree with the rail of the term Run slots, and the ⌘K search for "chia slot", each at 1440 and 390 px
// in light and dark. Each stage prints its first screen's words; a probe names what the map must show:
// the Unplaced row, a count opening its tree at its branch, the rail's relations, the term found first
// by its other name, and no page scrolling sideways. A tapped node's rail stands in view at every width,
// and the bar keeps the module's name on a phone (ISS-1256 r5).
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

/**
 * Nothing scrolls sideways: not the document, not the shell's scrolling main (whose own overflow the
 * document's width never shows, ISS-1256 c3 at 390), and no box draws past the window's right edge.
 */
function sideways(): string[] {
  const wrong: string[] = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${doc.scrollWidth} px in ${window.innerWidth}`);
  const main = q("[data-witness=main]");
  if (main && main.scrollWidth > main.clientWidth) wrong.push(`the main column scrolls sideways: ${main.scrollWidth} px in ${main.clientWidth}`);
  const past = [...(main?.querySelectorAll<HTMLElement>("*") ?? [])].filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().right > window.innerWidth + 0.5 && !el.closest(".sr-only"));
  for (const el of past.slice(0, 4)) wrong.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}" ends at ${Math.round(el.getBoundingClientRect().right)} px`);
  return wrong;
}

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

/** Tap the first rule: its rail must stand in the window, and the bar must still name the module. */
async function pick(): Promise<string[]> {
  const branch = q("[data-testid=tree-branch-rule]");
  if (!branch) return ["no Rules branch to open"];
  if (!branch.dataset.open) branch.querySelector<HTMLElement>("[data-testid=tree-branch-toggle]")?.click();
  await settle(300);
  branch.querySelector<HTMLElement>("[data-testid=tree-node]")?.click();
  await settle(900);
  const wrong: string[] = [];
  const rail = q("[data-testid=node-rail]");
  if (rail?.dataset.node !== "rule:one-slot-minimum") wrong.push(`the rail shows ${rail?.dataset.node} after the tap`);
  // the tapped node and its rail stand together in the window: a rail scrolled to below the whole tree
  // leaves the node it describes out of view
  const node = q('[data-testid=tree-node][data-node="rule:one-slot-minimum"]')?.getBoundingClientRect();
  const top = rail?.getBoundingClientRect().top ?? -1;
  const inView = (y: number | undefined) => y !== undefined && y >= 0 && y <= window.innerHeight - 120;
  if (!inView(node?.top) || !inView(top)) wrong.push(`the tapped node sits at ${Math.round(node?.top ?? -1)} px and its rail at ${Math.round(top)} px, in a ${window.innerHeight} px window`);
  if (!q("header")?.innerText.includes("Execution")) wrong.push("the bar does not name the module");
  return wrong;
}

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
    { name: "tree-pick-light", run: async () => [...(await pick()), ...sideways()] },
    { name: "tree-dark", run: async () => (theme("dark"), await settle(), sideways()) },
    { name: "search-light", run: async () => (theme("light"), address(""), show.view("search"), await settle(1200), [...search(), ...words("search", dialog())]) },
    { name: "search-dark", run: async () => (theme("dark"), await settle(), search()) },
  ],
};

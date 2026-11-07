// The project Agreements page witnessed in the workspace shell (REQ-90 BC-1, BC-9; ISS-1111): the lanes
// Forge default → Project change → Effective read side by side at 1440 px, an override's replaced default
// struck beside what agents get; at 390 px the page holds the name, the effective rule and the state
// without scrolling sideways; and the inspector opens an agreement's layers and history. Each stage
// prints its visible words (witness/first-screen.ts) and is shot in both themes.
//
//   pnpm --filter web-v2 witness witness/agreements-page.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BottomTabBar, TopBarSlotProvider } from "@/design";
import { AgreementsScreen } from "@/features/agreements";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { bottomTabItems } from "@/features/shell/nav-model";
import { AGREEMENT_RUNS, AGREEMENTS_PROJECT as P, AGREEMENTS_VIEW, agreementDetail } from "@/test/agreements.fixture";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.sessionStorage.clear();
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname.replace(/^\/api/, "");
  if (path === `/projects/${P}/agreements`) return json(AGREEMENTS_VIEW);
  const one = /\/agreements\/([a-z0-9-]+)$/.exec(path);
  if (one?.[1]) return json(agreementDetail(one[1]));
  if (path.endsWith("/runs/standing")) return json(AGREEMENT_RUNS);
  return new Promise<Response>(() => {});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const phone = window.innerWidth < 768;
const noop = () => {};

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/agreements" pattern="/projects/$slug/agreements">
    <QueryClientProvider client={client}>
      <TopBarSlotProvider>
        <div className="flex h-dvh overflow-hidden bg-shell" data-shell>
          {phone ? null : <div className="h-full flex-none border-r border-line bg-surface" style={{ width: 280 }} />}
          <div className="flex min-w-0 flex-1 flex-col" data-page data-witness="page">
            <ShellTopBar chatOpen={false} onToggleChat={noop} />
            <main className="min-h-0 flex-1 overflow-y-auto bg-app pb-[calc(56px+env(safe-area-inset-bottom))] window-md:pb-0" data-witness="main">
              <div className="flex min-h-full min-w-0 flex-col">
                <AgreementsScreen projectId={P} slug="hop" canManage />
              </div>
            </main>
          </div>
          <BottomTabBar items={bottomTabItems(4)} activeKey="home" onSelect={noop} />
        </div>
      </TopBarSlotProvider>
    </QueryClientProvider>
  </InRouter>,
);

const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

/** Prints the words a person sees, as the word budget counts them. */
function words(stage: string, root: HTMLElement | null): string[] {
  if (!root) return [`${stage}: nothing to count`];
  const { count, words: w } = firstScreenWords(root);
  console.log(`WORDS agreements-${stage} ${count} :: ${w.slice(0, 200).join(" ")}`);
  return [];
}

const sideways = () => (document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : []);

/** Each changed row draws its effective rule, readable, and an override its struck default beside it. */
function lanes(): string[] {
  const wrong: string[] = [];
  const rows = [...document.querySelectorAll<HTMLElement>("[data-testid=agreement-row]")];
  if (rows.length < 3) wrong.push(`${rows.length} agreement rows are drawn, not the three changes`);
  for (const r of rows) {
    const effective = r.querySelector<HTMLElement>(phone ? "[data-testid=lane-effective-phone]" : "[data-testid=lane-effective]");
    const w = effective?.getBoundingClientRect().width ?? 0;
    if (w < 140) wrong.push(`${r.dataset.name}'s effective rule is ${Math.round(w)} px wide`);
  }
  if (!phone) {
    const verify = rows.find((r) => r.dataset.name === "Proportional verification");
    if (!verify?.querySelector("[data-testid=lane-forge] .line-through")) wrong.push("the override's replaced default is not drawn struck in the Forge default lane");
  }
  return wrong;
}

function openInspector(): string[] {
  const row = [...document.querySelectorAll<HTMLElement>("[data-testid=agreement-row]")].find((r) => r.dataset.name === "Proportional verification");
  const name = row?.querySelector<HTMLButtonElement>("button");
  if (!name) return ["no row to open"];
  name.click();
  return [];
}

function inspector(): string[] {
  const d = document.querySelector<HTMLElement>("[data-testid=agreement-inspector]");
  if (!d) return ["the inspector did not open"];
  const wrong: string[] = [];
  for (const id of ["inspect-effective", "inspect-project", "inspect-forge", "inspect-history"]) if (!d.querySelector(`[data-testid=${id}]`)) wrong.push(`the inspector draws no ${id}`);
  return wrong;
}

const drawer = () => document.querySelector<HTMLElement>("[role=dialog]");

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => document.querySelectorAll("[data-testid=agreement-row]").length > 0,
  stages: [
    { name: "page-light", run: async () => (theme("light"), await settle(900), [...sideways(), ...lanes(), ...words(`page-${phone ? "390" : "1440"}-light`, document.querySelector("[data-witness=page]"))]) },
    { name: "page-dark", run: async () => (theme("dark"), await settle(), [...sideways(), ...words(`page-${phone ? "390" : "1440"}-dark`, document.querySelector("[data-witness=page]"))]) },
    { name: "inspector-light", run: async () => (theme("light"), openInspector(), await settle(900), [...inspector(), ...words(`inspector-${phone ? "390" : "1440"}-light`, drawer())]) },
    { name: "inspector-dark", run: async () => (theme("dark"), await settle(), [...inspector(), ...words(`inspector-${phone ? "390" : "1440"}-dark`, drawer())]) },
  ],
};

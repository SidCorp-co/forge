// The workspace rail collapsed and labelled, at 1440 and 390, light and dark (ISS-1073
// round 3, rail-collapsed-d on dev.571): collapsed, the rail is icons only everywhere in it, its top
// and its foot too. The org is its avatar, the tiers carry no label, What's new, Help and Search are
// their icons, the project's live runs a dot, and the version is the Docs button's hover. A probe names
// each word the collapsed rail draws; the labelled rail keeps its words. Each stage prints `WORDS rail-<name> <theme> <n>`.
//
//   pnpm --filter web-v2 witness witness/rail-icons.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActiveOrgProvider } from "@/features/orgs";
import { type ChromeScreen, gatherScreens } from "@/test/vi-chrome-screens";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";

const ORG = "0d1b2c3d-0000-4000-8000-000000000001";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if (path === "/orgs") return json([{ id: ORG, slug: "sidcorp", name: "SidCorp", isPersonal: false, role: "owner" }]);
  if (path === "/auth/me/preferences") return json({ activeOrgId: ORG });
  if (path === "/version") return json({ version: "0.4.0-dev.571", sourceCommit: null });
  if (path === "/me/whats-new/summary") return json({ environment: "dev", release: null });
  return new Promise<Response>(() => {});
};

const SEEDS: ChromeScreen[] = gatherScreens(import.meta.glob(["../src/test/vi-chrome-shell.tsx"], { eager: true, import: "SCREENS" }));
const seed = (name: string): ReactNode => {
  const s = SEEDS.find((x) => x.name === name);
  if (!s) throw new Error(`no seeded screen named "${name}"`);
  return s.render();
};

const PAGES = [
  { name: "collapsed", render: () => seed("Navigation rail · compact") },
  { name: "labelled", render: () => seed("Navigation rail · labelled") },
];

const at: { show: (i: number) => void } = { show: () => {} };
function Shell() {
  const [page, setPage] = useState(0);
  useEffect(() => {
    at.show = setPage;
  });
  const p = PAGES[page] ?? PAGES[0];
  return (
    <div className="flex h-dvh overflow-hidden bg-app" data-witness="page" key={p?.name}>
      {p?.render()}
    </div>
  );
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

/** Every word the collapsed rail draws: none but the org's, the project's and the person's avatar letters, and counts. */
function wordsInCollapsed(): string[] {
  const nav = q("nav");
  if (!nav) return ["no rail drawn"];
  const out: string[] = [];
  const walk = document.createTreeWalker(nav, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = n.textContent?.trim() ?? "";
    const el = n.parentElement;
    if (!text || !el || !el.checkVisibility() || el.closest("[aria-hidden=true], .sr-only")) continue;
    if (/^(\d+\+?|[A-Z]{2})$/.test(text)) continue;
    out.push(`the collapsed rail draws "${text}"`);
  }
  return out;
}

window.__witness = {
  cases: [
    { name: "wide-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(q("[data-witness=page]")),
  stages: PAGES.flatMap((p, i) =>
    (["light", "dark"] as const).map((t) => ({
      name: `${p.name}-${t}`,
      run: async () => {
        at.show(i);
        theme(t);
        await pause(900);
        const { count, words } = firstScreenWords(q("[data-witness=page]") as HTMLElement, { whole: true });
        console.log(`WORDS rail-${p.name} ${t} ${window.innerWidth} ${count} :: ${words.join(" ")}`);
        return p.name === "collapsed" ? wordsInCollapsed() : [];
      },
    })),
  ),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <InRouter at="/projects/hop/feedback" pattern="/projects/$slug/$">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })}>
      <ActiveOrgProvider>
        <Shell />
      </ActiveOrgProvider>
    </QueryClientProvider>
  </InRouter>,
);

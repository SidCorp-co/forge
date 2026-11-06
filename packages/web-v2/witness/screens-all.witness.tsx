// Every routed screen of web-v2 that a fixture can draw, each in the shell at 1440 by 900 (ISS-903's
// "before"): the words a person sees before scrolling are counted (witness/first-screen.ts) and
// printed as `<name> <theme>: <n> words`, and each stage is shot to `<out>/wide-1440-<name>-<theme>.png`.
// The screens drawn here are those with a seed: the vi walking test's (`src/test/vi-chrome-*.tsx`), the
// project home's and the ones of screens-act. A routed screen with no seed is in witness/screens.inventory.ts
// marked estimated, never drawn here.
//
//   [VITE_WITNESS_THEMES=light,dark] [VITE_WITNESS_ONLY=name,name] pnpm --filter web-v2 witness witness/screens-all.witness.tsx --out <dir>
//
// A screen that throws or draws nothing is named and fails the run: it is never a screen with few words.
//
// VITE_WITNESS_WHOLE=1 draws each page unscrolled, its whole height in the shot, and prints the words
// of the whole page as `WHOLE <name> <theme> <n>`: what a person reads by scrolling to the end.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { type ChromeScreen, gatherScreens } from "@/test/vi-chrome-screens";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";
import { Caught, FEEDBACK_TITLED, HomePage, ISSUE_TITLED, REQUIREMENTS_TITLED } from "./screens.fixture";
import { SCREEN_PAGES } from "./screens.pages";

const THEMES = (import.meta.env.VITE_WITNESS_THEMES ?? "light").split(",") as ("light" | "dark")[];
const WHOLE = import.meta.env.VITE_WITNESS_WHOLE === "1";

const replace = window.history.replaceState.bind(window.history);
window.history.replaceState = (data, unused, url) => {
  try {
    replace(data, unused, url);
  } catch {
    /* the page stays at its file:// address; the fixtures read nothing from it */
  }
};

const VI: ChromeScreen[] = gatherScreens(import.meta.glob(["../src/test/vi-chrome-*.tsx", "!../src/test/vi-chrome-screens.tsx"], { eager: true, import: "SCREENS" }));
const vi = (name: string): ReactNode => {
  const s = VI.find((x) => x.name === name);
  if (!s) throw new Error(`no vi screen named "${name}"`);
  return s.render();
};

const PAGES = SCREEN_PAGES({ vi, HomePage, ISSUE_TITLED, REQUIREMENTS_TITLED, FEEDBACK_TITLED });
const only = import.meta.env.VITE_WITNESS_ONLY as string | undefined;
const SHOWN = only ? PAGES.filter((p) => only.split(",").includes(p.name)) : PAGES;

/** The page is drawn inside the boundary: a render that throws is named by its stage, not the end of the run. */
function Draw({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

const at: { show: (i: number) => void } = { show: () => {} };

function Shell() {
  const [page, setPage] = useState(0);
  useEffect(() => {
    at.show = setPage;
  });
  const p = SHOWN[page] ?? SHOWN[0];
  return (
    <InRouter key={p.name} at={p.path} pattern={p.pattern ?? "/projects/$slug/$"}>
      <TopBarSlotProvider>
        {p.bare ? (
          <div className={WHOLE ? "min-h-dvh bg-app" : "h-dvh overflow-y-auto bg-app"} data-witness="page" data-witness-page={p.name} data-page>
            <Caught key={p.name}>
              <Draw render={p.render} />
            </Caught>
          </div>
        ) : (
        <div className={WHOLE ? "flex min-h-dvh bg-app" : "flex h-dvh overflow-hidden bg-app"} data-shell>
          <div className="hidden h-full flex-none border-r border-line bg-surface md:block" style={{ width: 280 }} />
          <div className="flex min-w-0 flex-1 flex-col" data-witness="page" data-witness-page={p.name} data-page>
            <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
            <main className={WHOLE ? "flex-1" : "min-h-0 flex-1 overflow-y-auto"} data-witness="main">
              <Caught key={p.name}><Draw render={p.render} /></Caught>
            </main>
          </div>
        </div>
        )}
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
  stages: SHOWN.flatMap((p, i) =>
    THEMES.map((t) => ({
      name: `${p.name}-${t}`,
      run: async () => {
        at.show(i);
        theme(t);
        await pause(1100);
        if (p.tab) {
          const tab = [...document.querySelectorAll<HTMLElement>("[role=tab],button")].find((b) => b.textContent?.trim() === p.tab);
          if (!tab) return [`the ${p.name} page has no ${p.tab} tab to open`];
          tab.click();
          await pause(500);
        }
        const threw = q("[data-witness=threw]");
        if (threw) return [`the ${p.name} page threw: ${threw.innerText.slice(0, 300)}`];
        if (window.innerHeight !== 900) return [`the window is ${window.innerHeight} px tall, not 900`];
        const { count, words } = firstScreenWords(q("[data-witness=page]") as HTMLElement, { whole: WHOLE });
        console.log(`${WHOLE ? "WHOLE" : "WORDS"} ${p.name} ${t} ${count} :: ${words.slice(0, 400).join(" ")}`);
        return count < 8 ? [`the ${p.name} page drew ${count} words: it did not draw its screen`] : [];
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

// The list and settings screens ISS-1071, ISS-1072 and ISS-1073 rebuilt, each in the shell at 1440 and
// at a phone's 390, in the themes named: Integrations, Modules, Requirements, Feedback, Channels,
// Automation, Runners, project settings (General, Delivery), account preferences, a release page and
// the rail. Each stage prints `WORDS <page> <theme> <n>` (the first screen's words, witness/first-screen.ts)
// and is shot to `<out>/<case>-<page>-<theme>.png`. A probe names what the batch removed, so a screen
// that brings one back fails by name: a table header drawn uppercase or monospace, a module tile map,
// an id as the first text of an Integrations row, a Waiting-on cell that wraps past one line.
//
//   [VITE_WITNESS_THEMES=light,dark] [VITE_WITNESS_ONLY=name,name] pnpm --filter web-v2 witness witness/list-screens.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { ChannelsScreen } from "@/features/channels";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { ModulesScreen } from "@/features/modules";
import { RequirementsScreen } from "@/features/requirements/components/requirements-screen";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { type ChromeScreen, gatherScreens } from "@/test/vi-chrome-screens";
import { MODULE_QUERIES, MODULES_PROJECT } from "@/test/module-rollup";
import { P as FB_P } from "@/test/vi-chrome-feedback";
import { REQ_PROJECT, Seeded } from "@/test/vi-chrome-requirements";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";
import { Caught, FEEDBACK_TITLED, REQUIREMENTS_TITLED } from "./screens.fixture";

const THEMES = (import.meta.env.VITE_WITNESS_THEMES ?? "light,dark").split(",") as ("light" | "dark")[];

const replace = window.history.replaceState.bind(window.history);
window.history.replaceState = (data, unused, url) => {
  try {
    replace(data, unused, url);
  } catch {
    /* the page stays at its file:// address; the fixtures read nothing from it */
  }
};

const SEEDS: ChromeScreen[] = gatherScreens(import.meta.glob(["../src/test/vi-chrome-*.tsx", "!../src/test/vi-chrome-screens.tsx"], { eager: true, import: "SCREENS" }));
const seed = (name: string): ReactNode => {
  const s = SEEDS.find((x) => x.name === name);
  if (!s) throw new Error(`no seeded screen named "${name}"`);
  return s.render();
};

const MP = MODULES_PROJECT;
const CHANNELS = { channels: [{ rid: "GENERAL-rid-1", name: "Forge-Communicate", members: 0, rules: 0, commonIssues: 0 }, { rid: "r2", name: "hop-support", members: 12, rules: 3, commonIssues: 4 }] };

interface Page {
  name: string;
  path: string;
  pattern?: string;
  render: () => ReactNode;
}

const P = "/projects/hop";
const PAGES: Page[] = [
  { name: "rail", path: P, pattern: "/projects/$slug", render: () => seed("Navigation rail · labelled") },
  { name: "integrations", path: "/integrations", pattern: "/integrations", render: () => seed("Integrations") },
  { name: "modules", path: `${P}/modules`, render: () => <Seeded data={MODULE_QUERIES}><ModulesScreen projectId={MP} slug="hop" /></Seeded> },
  { name: "requirements", path: `${P}/requirements`, render: () => <Seeded data={REQUIREMENTS_TITLED}><RequirementsScreen projectId={REQ_PROJECT} slug="hop" /></Seeded> },
  { name: "feedback", path: `${P}/feedback`, render: () => <Seeded data={FEEDBACK_TITLED}><FeedbackScreen projectId={FB_P} slug="hop" /></Seeded> },
  { name: "channels", path: `${P}/channels`, render: () => <Seeded data={[[["channels", MP], CHANNELS]]}><ChannelsScreen projectId={MP} slug="hop" /></Seeded> },
  { name: "automation", path: `${P}/automation`, render: () => seed("Automation · schedules") },
  { name: "runners", path: "/runners", pattern: "/runners", render: () => seed("Runners") },
  { name: "project-settings-general", path: `${P}/settings`, render: () => seed("Project settings · General") },
  { name: "project-settings-delivery", path: `${P}/settings`, render: () => seed("Project settings · Delivery") },
  { name: "account", path: "/settings", pattern: "/settings", render: () => seed("Account preferences") },
  { name: "release", path: `${P}/releases/0.3.2`, render: () => seed("Release detail") },
];

const only = import.meta.env.VITE_WITNESS_ONLY as string | undefined;
const SHOWN = only ? PAGES.filter((p) => only.split(",").includes(p.name)) : PAGES;

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
        <div className="flex h-dvh overflow-hidden bg-app" data-shell>
          <div className="flex min-w-0 flex-1 flex-col" data-witness="page" data-witness-page={p.name} data-page>
            <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
            <main className="min-h-0 flex-1 overflow-y-auto" data-witness="main">
              <Caught key={p.name}>
                <Draw render={p.render} />
              </Caught>
            </main>
          </div>
        </div>
      </TopBarSlotProvider>
    </InRouter>
  );
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const all = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** What the batch removed, found again on the page drawn. */
function regressions(name: string): string[] {
  const out: string[] = [];
  for (const th of all("th, [data-testid=list-header] > *")) {
    const s = getComputedStyle(th);
    if (th.innerText.trim() && s.textTransform === "uppercase") out.push(`${name}: the header "${th.innerText.trim()}" is drawn uppercase`);
    if (th.innerText.trim() && /mono/i.test(s.fontFamily)) out.push(`${name}: the header "${th.innerText.trim()}" is drawn monospace`);
  }
  if (name === "modules" && q("[data-testid=module-level-map]")) out.push("modules: the tile map is drawn above the list");
  if (name === "integrations") {
    for (const chip of all("main *")) {
      // an SVG node has no innerText: read every leaf by its text content
      const text = (chip.textContent ?? "").trim();
      if (chip.children.length === 0 && UUID.test(text) && chip.getBoundingClientRect().width > 0) {
        out.push(`integrations: "${text.slice(0, 40)}" is drawn as text`);
        break;
      }
    }
  }
  for (const w of all("[data-testid=waiting-on], [data-testid=req-waits]")) {
    const lines = Math.round(w.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(w).lineHeight || "18"));
    if (lines > 1) out.push(`${name}: a Waiting-on cell wraps to ${lines} lines ("${w.innerText.slice(0, 60)}")`);
  }
  if (name === "rail" && all("a, button").some((a) => a.innerText.trim() === "Approvals")) out.push("rail: Approvals has a row");
  return out;
}

window.__witness = {
  cases: [
    { name: "wide-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(q("[data-witness=page]")),
  stages: SHOWN.flatMap((p, i) =>
    THEMES.map((t) => ({
      name: `${p.name}-${t}`,
      run: async () => {
        at.show(i);
        theme(t);
        await pause(1100);
        const threw = q("[data-witness=threw]");
        if (threw) return [`the ${p.name} page threw: ${threw.innerText.slice(0, 300)}`];
        const { count, words } = firstScreenWords(q("[data-witness=page]") as HTMLElement);
        console.log(`WORDS ${p.name} ${t} ${window.innerWidth} ${count} :: ${words.slice(0, 300).join(" ")}`);
        if (count < 8) return [`the ${p.name} page drew ${count} words: it did not draw its screen`];
        return import.meta.env.VITE_WITNESS_PROBE === "1" ? regressions(p.name) : [];
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

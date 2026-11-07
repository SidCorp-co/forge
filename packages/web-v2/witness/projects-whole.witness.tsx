// The Projects table in the shell at 1440 and at a phone's 390, light and dark (ISS-1072 round 3),
// drawn over the case forge-core-61's QA read on dev.571: its last-active time ("2m") stood in a
// column with no header, and its Team avatars lay over each other. Each stage prints
// `WORDS projects <theme> <width> <n>` (witness/first-screen.ts), is shot to
// `<out>/<case>-projects-<theme>.png`, and names any column with no header and any avatar over another.
//
//   pnpm --filter web-v2 witness witness/projects-whole.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { ProjectList } from "@/features/projects/components/project-list";
import type { ProjectConsoleItem } from "@/features/projects/types";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";

const THEMES = ["light", "dark"] as const;
const NOW = Date.now();
const AT = "2026-10-15T08:00:00.000Z";
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const project = (id: string, name: string, members: string[], minutes: number): ProjectConsoleItem => ({
  id,
  slug: name.toLowerCase(),
  name,
  orgId: "o1",
  orgName: "SidCorp",
  orgIsPersonal: false,
  role: "admin",
  orgRole: "owner",
  createdAt: AT,
  health: "healthy",
  liveRuns: 0,
  openIssues: 74,
  runnerCount: 1,
  spend24hUsd: 0,
  memberCount: members.length,
  members,
  lastActivityAt: ago(minutes),
  pinned: false,
});
const PROJECTS = [project("p1", "Forge", ["OR", "QA", "FO", "ST"], 2), project("p2", "Agenfold", ["OR", "AG", "ST", "QA"], 49)];

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** A column with no header, and a Team avatar lying over the one before it. */
function wrong(): string[] {
  const out: string[] = [];
  for (const th of document.querySelectorAll<HTMLTableCellElement>("th")) if (!th.innerText.trim() && th.cellIndex > 0) out.push(`column ${th.cellIndex + 1} has no header`);
  for (const row of document.querySelectorAll<HTMLElement>("tbody tr")) {
    const marks = [...row.querySelectorAll<HTMLElement>("td:last-child div > span")];
    for (let i = 1; i < marks.length; i++) {
      const [a, b] = [marks[i - 1], marks[i]] as [HTMLElement, HTMLElement];
      if (overlap(a.getBoundingClientRect(), b.getBoundingClientRect())) out.push(`a Team avatar "${b.innerText}" lies over "${a.innerText}"`);
    }
  }
  return [...new Set(out)].slice(0, 8);
}

window.__witness = {
  cases: [
    { name: "wide-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(q("[data-witness=page]")),
  stages: THEMES.map((t) => ({
    name: `projects-${t}`,
    run: async () => {
      theme(t);
      await pause(1200);
      const { count, words } = firstScreenWords(q("[data-witness=page]") as HTMLElement);
      console.log(`WORDS projects ${t} ${window.innerWidth} ${count} :: ${words.slice(0, 300).join(" ")}`);
      if (count < 5) return [`the projects page drew ${count} words: it did not draw its screen`];
      return wrong();
    },
  })),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })}>
    <InRouter at="/projects" pattern="/projects">
      <TopBarSlotProvider>
        <div className="flex h-dvh overflow-hidden bg-app" data-shell>
          <div className="flex min-w-0 flex-1 flex-col" data-witness="page" data-witness-page="projects" data-page>
            <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
            <main className="min-h-0 flex-1 overflow-y-auto" data-witness="main">
              <div className="px-8 py-6">
                <ProjectList items={PROJECTS} now={NOW} spend={false} onTogglePin={() => {}} />
              </div>
            </main>
          </div>
        </div>
      </TopBarSlotProvider>
    </InRouter>
  </QueryClientProvider>,
);

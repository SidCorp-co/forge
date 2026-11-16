// Agents / Capabilities witnessed in the workspace shell (ISS-1251 §7): the tab opens on its overview
// (figures, doors by standing, calls against refusals per day), the project's budgets and reading one
// line each, then the doors by standing; a door no agent called reads "Teach better / redesign /
// delete"; a door opens in a drawer; at 390 px nothing scrolls sideways. Each stage prints its words.
//
//   pnpm --filter web-v2 witness witness/capabilities.witness.tsx --out <dir>

import type { CapabilitiesView } from "@forge/contracts/capabilities";
import type { CapabilityCard } from "@forge/contracts/capability-cards";
import type { DoorUseRow, DoorUseView, PilesView } from "@forge/contracts/door-use";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BottomTabBar, TopBarSlotProvider } from "@/design";
import { AgentsScreen } from "@/features/agents";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { bottomTabItems } from "@/features/shell/nav-model";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";

const P = "p-cap";
const card = (purpose: string, audience: CapabilityCard["audience"]): CapabilityCard => ({
  id: "x",
  owner: "x",
  purpose,
  situations: [{ when: "Someone writes you have no record of", do: "read who they are before you answer" }],
  practice: ["Read the member before you reply", "Record what they told you"],
  redFlag: "Answering a stranger as if you knew them",
  audience,
  scenarios: [],
  changed: { on: "2026-11-16", by: "ISS-1251" },
});
const door = (id: string, over: Partial<DoorUseRow>): DoorUseRow => ({
  door: id,
  surface: "mcp",
  summary: null,
  feature: "forge_support",
  card: null,
  tiers: {},
  calls: 0,
  refused: 0,
  refusedBy: {},
  byAgent: {},
  lastAt: null,
  ...over,
});
const DOORS: DoorUseRow[] = [
  door("issues.update", { summary: "Changes an issue's fields", card: card("Changes an issue's fields", ["master", "run"]), tiers: { master: 0, run: 1 }, calls: 41, refused: 2, refusedBy: { not_found: 2 }, byAgent: { box: 30, checkout: 11 }, lastAt: "2026-11-16T03:00:00Z" }),
  door("memory.search", { summary: "Finds what agents learned", card: card("Finds what agents learned before", ["master", "run", "bot"]), tiers: { master: 0, run: 0, bot: 1 }, calls: 37, byAgent: { "session:master": 20, checkout: 17 } }),
  door("support.reply", { summary: "Answers in a room", card: card("Answers someone in a room", ["bot"]), tiers: { bot: 0 }, calls: 12, refused: 5, refusedBy: { SUPPORT_ACT_DENIED: 5 }, byAgent: { "room:support": 12 } }),
  door("issues.comment", { summary: "Comments on an issue", calls: 9, byAgent: { box: 9 } }),
  door("support.member", { summary: "Records who a member is", card: card("Records who a member is", ["bot"]), tiers: { bot: 0 }, calls: 0 }),
  door("support.rule", { summary: "Keeps a rule for the room", calls: 0 }),
  door("releases.record", { summary: "Records a release", calls: 0 }),
  door("POST /api/projects/:id/debts", { surface: "rest", feature: "/api/projects/:id/debts", calls: 3, byAgent: { box: 3 } }),
  door("PUT /api/projects/:id/policy", { surface: "rest", feature: "/api/projects/:id/policy", calls: 0 }),
];
const days = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 18 + i));
  return { day: d.toISOString().slice(0, 10), calls: (i * 7) % 11, refused: i % 6 === 0 ? 2 : 0 };
});
const USE: DoorUseView = {
  projectId: P,
  window: { days: 30, since: "2026-10-17T00:00:00Z", until: "2026-11-16T00:00:00Z" },
  doors: DOORS,
  totals: { doors: DOORS.length, neverUsed: DOORS.filter((d) => d.calls === 0).length, calls: DOORS.reduce((n, d) => n + d.calls, 0), taught: DOORS.filter((d) => d.card).length },
  days,
  unmatched: [],
  reads: [
    { agent: "session:master", kind: "knowledge", how: "get", reaches: 14, entries: 6, top: [] },
    { agent: "checkout", kind: "memory", how: "search", reaches: 9, entries: 9, top: [] },
  ],
  lessonsApplied: [{ lesson: "L-7", agent: "agent-account", applications: 3 }],
  limits: [],
};
const PILES: PilesView = {
  projectId: P,
  piles: [
    { pile: "always_knowledge", name: "always-on knowledge", size: 7200, cap: 6000, items: 14, carried: 14, over: true },
    { pile: "lessons_map", name: "lessons map (runs)", size: 1100, cap: 1200, items: 22, carried: 18, over: true },
    { pile: "tier0_map", name: "map (bot)", size: 900, cap: 2500, items: 9, carried: 9, over: false },
    { pile: "tier0_map", name: "map (master)", size: 2100, cap: 2500, items: 21, carried: 21, over: false },
    { pile: "tier0_map", name: "map (run)", size: 1800, cap: 2500, items: 17, carried: 17, over: false },
    { pile: "skill_always_on", name: "forge-master", size: 600, cap: 1024, items: 1, carried: 1, over: false },
  ],
};
const EXTRA: CapabilitiesView = {
  projectId: P,
  window: USE.window,
  feedback: [{ door: "support.reply", reports: 2, byVerdict: { unclear: 2 }, lastAt: "2026-11-15T00:00:00Z" }],
  lessons: [{ card: "memory.search", number: 7, sentence: "Search memory before designing a fix", status: "approved", invalid: true, invalidBy: "a landing touched memory search", applied: 3, lastAppliedAt: null }],
  limits: [],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.sessionStorage.clear();
// the Agents screen reads its tab off the address, as a shared link opens it
window.history.replaceState(null, "", `${window.location.pathname}?tab=capabilities`);
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://forge.test").pathname.replace(/^\/api/, "");
  if (path === `/projects/${P}/metrics/doors`) return json(USE);
  if (path === `/projects/${P}/metrics/piles`) return json(PILES);
  if (path === `/projects/${P}/metrics/capabilities`) return json(EXTRA);
  return new Promise<Response>(() => {});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const phone = window.innerWidth < 768;
const noop = () => {};

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/agents?tab=capabilities" pattern="/projects/$slug/agents">
    <QueryClientProvider client={client}>
      <TopBarSlotProvider>
        <div className="flex h-dvh overflow-hidden bg-shell" data-shell>
          {phone ? null : <div className="h-full flex-none border-r border-line bg-surface" style={{ width: 280 }} />}
          <div className="flex min-w-0 flex-1 flex-col" data-page data-witness="page">
            <ShellTopBar chatOpen={false} onToggleChat={noop} />
            <main className="min-h-0 flex-1 overflow-y-auto bg-app pb-[calc(56px+env(safe-area-inset-bottom))] window-md:pb-0" data-witness="main">
              <div className="flex min-h-full min-w-0 flex-col">
                <AgentsScreen access={{ projectId: P, slug: "hop", canWrite: true }} />
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

function words(stage: string, root: HTMLElement | null): string[] {
  if (!root) return [`${stage}: nothing to count`];
  const { count, words: w } = firstScreenWords(root);
  console.log(`WORDS capabilities-${stage} ${count} :: ${w.slice(0, 200).join(" ")}`);
  return [];
}

const sideways = () => (document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : []);

function face(): string[] {
  const wrong: string[] = [];
  const unused = [...document.querySelectorAll<HTMLElement>("[data-testid=cap-door][data-standing=unused]")];
  if (unused.length === 0) wrong.push("no unused door is drawn");
  for (const u of unused) if (!u.querySelector("[data-testid=cap-standing]")?.textContent?.startsWith("Teach better / redesign / delete")) wrong.push(`an unused door reads ${u.textContent?.slice(0, 60)}`);
  if (!document.querySelector("[data-testid=capabilities-band-chart]")) wrong.push("the overview draws no chart");
  return wrong;
}

function openMisused(): string[] {
  const head = document.querySelector<HTMLElement>("[data-testid=cap-door][data-standing=misused] [data-expand-head]");
  if (!head) return ["no misused door to open"];
  head.click();
  return [];
}

const drawer = () => document.querySelector<HTMLElement>("[role=dialog]");

function openBudgets(): string[] {
  const fold = document.querySelector<HTMLElement>("[data-testid=cap-budgets] button");
  if (!fold) return ["no budgets line to open"];
  fold.click();
  return [];
}

/** The budgets drawer marks each pile over its cap Over, and none within it. */
function budgets(): string[] {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-testid=cap-pile]")];
  if (rows.length === 0) return ["the budgets drawer lists no pile"];
  const over = rows.filter((r) => r.querySelector("[data-testid=cap-pile-over]")).length;
  return over === 2 ? [] : [`${over} piles read Over, not the two over their cap`];
}

const shut = () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => document.querySelectorAll("[data-testid=cap-door]").length > 0,
  stages: [
    { name: "page-light", run: async () => (theme("light"), await settle(900), [...sideways(), ...face(), ...words(`page-${phone ? "390" : "1440"}-light`, document.querySelector("[data-witness=page]"))]) },
    { name: "page-dark", run: async () => (theme("dark"), await settle(), [...sideways()]) },
    { name: "budgets-light", run: async () => (theme("light"), openBudgets(), await settle(900), [...budgets(), ...words(`budgets-${phone ? "390" : "1440"}`, drawer())]) },
    { name: "door-light", run: async () => (shut(), await settle(600), openMisused(), await settle(900), [...(drawer() ? [] : ["the door opened no drawer"]), ...words(`door-${phone ? "390" : "1440"}`, drawer())]) },
  ],
};

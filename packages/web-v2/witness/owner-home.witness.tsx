// The workspace home a person opens (ISS-919, FB-483): what waits on them, what is moving for what
// they gave, and what is live, three flat tables in that order, with the org figures under a tab.
// Mounted in the workspace's own column and `main` at 1440 and 390, light and dark, each with the
// longest words it meets in the field. Each stage reads `main.scrollWidth` against its
// `main.clientWidth` (ISS-691), checks the three sections stand in order with no card mosaic, and
// prints the first screen's words (`WORDS owner-home <theme> <n>`); the Figures stage prints what
// today's Overview drew (`WORDS overview-figures …`), the count before this page. Moving is cut as
// core cuts it, so the stage reads its "N of M"; the idle stage opens the Idle row and reads each idle
// item's age in words.
//
//   pnpm --filter web-v2 witness witness/owner-home.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { WORKSPACE_MAIN, WORKSPACE_PAGE_COLUMN } from "@/design/templates/workspace-frame";
import { ActiveOrgProvider } from "@/features/orgs";
import { HomeScreen } from "@/features/overview";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import "./entry";
import { firstScreenWords } from "./first-screen";
import { ATTENTION, FIND, HOME, ORG, PULSE } from "./owner-home.fixture";
import { InRouter } from "./router";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://witness.test");
  const path = url.pathname.replace(/^\/api/, "");
  if (path === "/me/attention") return json(ATTENTION);
  if (path === "/me/home") return json(HOME);
  if (path === "/me/home/find") return json(FIND);
  if (path === "/me/pulse") return json(PULSE);
  if (path === "/projects") return json([]);
  if (path === "/orgs") return json([{ id: ORG, slug: "sidcorp", name: "SidCorp", isPersonal: false, role: "owner" }]);
  if (path === "/auth/me/preferences") return json({ activeOrgId: ORG });
  // a read no fixture answers stays in flight, drawing its loading state
  return new Promise<Response>(() => {});
};

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

function sideways(): string[] {
  const main = q("main");
  if (!main) return ["the page is not mounted in the workspace's main"];
  if (main.scrollWidth <= main.clientWidth) return [];
  const wide = [...main.querySelectorAll<HTMLElement>("*")]
    .filter((el) => el.getBoundingClientRect().right > main.getBoundingClientRect().right + 1 && el.children.length === 0)
    .slice(0, 5)
    .map((el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""} ${Math.round(el.getBoundingClientRect().width)} px`);
  return [`main scrolls sideways: ${main.scrollWidth} px in ${main.clientWidth}; widest: ${wide.join(", ")}`];
}

/** The most free width a row may leave beside a name it cuts: past it, the name was cut for no reason. */
const SLACK_MAX = 150;

/** The width a cell's content draws, inside its padding. */
function contentWidth(cell: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(cell);
  return range.getBoundingClientRect().width;
}

/** A cell's width its content leaves unused. */
function slack(cell: HTMLElement): number {
  const st = getComputedStyle(cell);
  const inner = cell.getBoundingClientRect().width - Number.parseFloat(st.paddingLeft) - Number.parseFloat(st.paddingRight);
  return Math.max(0, inner - contentWidth(cell));
}

/** A name cut (ellipsis or clamp) while its row leaves more than SLACK_MAX px unused (ISS-919 fix round). */
function namesCutWithRoom(): string[] {
  const wrong: string[] = [];
  for (const row of document.querySelectorAll<HTMLElement>("[data-testid=home-waiting-row], [data-testid=home-moving-row], [data-testid=home-live-row]")) {
    const name = row.querySelector<HTMLElement>("td a");
    if (!name) continue;
    const cut = name.scrollWidth > name.clientWidth + 1 || name.scrollHeight > name.clientHeight + 1;
    if (!cut) continue;
    const free = [...row.querySelectorAll<HTMLElement>(":scope > td")].reduce((n, td) => n + slack(td), 0);
    if (free > SLACK_MAX) wrong.push(`"${name.textContent?.slice(0, 40)}" is cut while its row leaves ${Math.round(free)} px free`);
  }
  return wrong;
}

function sections(): string[] {
  const order = ["home-waiting", "home-moving", "home-live"].map((id) => q(`[data-testid=${id}]`));
  if (order.some((s) => !s)) return ["the home does not draw all three sections: waiting on you, moving, live"];
  const [a, b, c] = order as HTMLElement[];
  const wrong: string[] = [];
  if (!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) || !(b.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING))
    wrong.push("the sections are not in the order waiting on you, moving, live");
  // flat tables: no row is a boxed, shadowed card
  const carded = [...document.querySelectorAll<HTMLElement>("[data-testid^=home-] tr, [data-testid^=home-] li")].filter((el) => getComputedStyle(el).boxShadow !== "none");
  if (carded.length > 0) wrong.push(`${carded.length} rows draw a shadow, as a card would`);
  for (const r of document.querySelectorAll<HTMLElement>("[data-testid=home-moving-date]")) {
    if (!r.textContent?.trim()) wrong.push("a Moving row's date is blank, not words");
  }
  const cut = q("[data-testid=home-moving] [data-testid=home-cut]")?.textContent ?? "";
  if (!/^\d+ of \d+$/.test(cut)) wrong.push(`Moving is cut and does not say so: "${cut}"`);
  if (!q("[data-testid=home-moving-idle]")) wrong.push("Moving draws no Idle row for its idle items");
  if (document.querySelector("[data-testid=home-moving-row][data-idle]")) wrong.push("an idle item shows before Idle is opened");
  return wrong;
}

/** Opens Idle and reads each idle row's age, in words. */
function idleOpened(): string[] {
  const idle = q("[data-testid=home-moving-idle]");
  if (!idle) return ["Moving draws no Idle row"];
  if (idle.getAttribute("aria-expanded") !== "true") idle.click();
  return [];
}

function idleAges(): string[] {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-testid=home-moving-idle-list] [data-testid=home-moving-row]")];
  if (rows.length === 0) return ["Idle opened to no rows"];
  return rows.flatMap((r) => {
    const age = r.querySelector("[data-testid=home-moving-age]")?.textContent?.trim() ?? "";
    return /\d+\s?\S+/.test(age) ? [] : [`an idle row reads no age in words: "${age}"`];
  });
}

const words = (name: string, t: string) => {
  const column = q("[data-witness=page]");
  if (!column) return;
  const { count, words: w } = firstScreenWords(column);
  console.log(`WORDS ${name} ${t} ${count} :: ${w.join(" ")}`);
};

const tab = (label: string) => [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((b) => b.textContent?.trim() === label);

const homeStage = (t: "light" | "dark") => ({
  name: `home-${t}`,
  run: async () => {
    tab("Home")?.click();
    theme(t);
    await pause(700);
    words("owner-home", t);
    return [...sideways(), ...sections(), ...namesCutWithRoom()];
  },
});

window.__witness = {
  cases: [
    { name: "wide-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(q("[data-testid=home-moving-row]") && q("[data-testid=home-waiting-row]") && q("[data-testid=home-live-row]")),
  stages: [
    homeStage("light"),
    homeStage("dark"),
    {
      name: "idle-open-light",
      run: async () => {
        theme("light");
        const opened = idleOpened();
        await pause(400);
        q("[data-testid=home-moving-idle-list]")?.scrollIntoView({ block: "center" });
        await pause(200);
        return [...opened, ...idleAges(), ...sideways()];
      },
    },
    {
      name: "figures-light",
      run: async () => {
        theme("light");
        const figures = tab("Figures");
        if (!figures) return ["the home has no Figures tab"];
        figures.click();
        await pause(900);
        words("overview-figures", "light");
        return sideways();
      },
    },
  ],
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <InRouter at="/" pattern="/">
    <QueryClientProvider client={client}>
      <ActiveOrgProvider>
      <TopBarSlotProvider>
        <div className="flex h-screen bg-app text-fg">
          <div className={WORKSPACE_PAGE_COLUMN} data-witness="page">
            <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
            <main className={WORKSPACE_MAIN}>
              <HomeScreen />
            </main>
          </div>
        </div>
      </TopBarSlotProvider>
      </ActiveOrgProvider>
    </QueryClientProvider>
  </InRouter>,
);

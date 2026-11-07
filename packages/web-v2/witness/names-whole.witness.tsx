// ISS-1072 round 3's screens, each in the shell at 1440 and at a phone's 390, light and dark, drawn over
// the live cases forge-core-61's QA read on dev.571: an issue page whose long title ran under the bar's
// acts, Issues rows that cut the owner to "orchestr…" beside a long ETA, Project settings › People
// naming agents by their minted addresses beside a share link with no name, the Projects table's
// unheaded "2m" column and clipped Team avatars, and the Feedback header's two buttons named Feedback.
// Each stage prints `WORDS <page> <theme> <width> <n>` (witness/first-screen.ts), is shot to
// `<out>/<case>-<page>-<theme>.png`, and names what is wrong on the page drawn.
//
//   [VITE_WITNESS_ONLY=name,name] pnpm --filter web-v2 witness witness/names-whole.witness.tsx --out <dir>

import type { ShareLinkView } from "@forge/contracts/shares";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActorChip, GroupedList, type ListRowView, StatusChip, TopBarSlotProvider, useGroupFold } from "@/design";
import { EtaCell } from "@/features/forecast";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { IssueDetailScreen } from "@/features/issues/components/issue-detail-screen";
import { MembersTab } from "@/features/project-settings/components/members-tab";
import { ShareSettings } from "@/features/project-settings/components/shares-section";
import { ProjectList } from "@/features/projects/components/project-list";
import type { ProjectConsoleItem } from "@/features/projects/types";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { P as FB_P } from "@/test/vi-chrome-feedback";
import { Seeded } from "@/test/vi-chrome-requirements";
import { firstScreenWords } from "./first-screen";
import "./entry";
import { InRouter } from "./router";
import { Caught, FEEDBACK_TITLED, ISSUE_TITLED } from "./screens.fixture";

const THEMES = ["light", "dark"] as const;
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const replace = window.history.replaceState.bind(window.history);
window.history.replaceState = (data, unused, url) => {
  try {
    replace(data, unused, url);
  } catch {
    /* the page stays at its file:// address; the fixtures read nothing from it */
  }
};

// ── the issue page: ISS-1091's title, as long as it ran on dev.571 ──
const LONG_TITLE = "A confirmed-fixed notice for a read-only request carries no result, so the channel agent cannot say what changed for the person who asked it in the room";
const ISSUE_LONG: [QueryKey, unknown][] = ISSUE_TITLED.map(([key, value]) =>
  key[0] === "issue" && key[1] === "i1" && key.length <= 3 && (value as { displayId?: string }).displayId ? [key, { ...(value as object), title: LONG_TITLE }] : [key, value],
);

// ── Issues rows as dev.571 drew them: a long ETA beside an owner and an age ──
interface Row {
  key: string;
  title: string;
  state: string;
  wait: string;
  eta: number | null;
  owner: string | null;
  age: number;
}
const ROWS: Row[] = [
  { key: "ISS-1088", title: "The app shell loads attention, releases and needs-you on every route, so each screen waits", state: "In progress · Build", wait: "Run · Build · 5 min", eta: 22 * 60, owner: "orchestrator", age: 5 },
  { key: "ISS-1095", title: "A cancelled release run's state and release attempts drop the abort record", state: "In progress · Build", wait: "Run · Build · 34 min", eta: 40, owner: "orchestrator", age: 33 },
  { key: "ISS-1090", title: "A release whose production deploy waits on a person's confirm reads as no one's wait", state: "Open", wait: "Master · dispatch a run", eta: 26 * 60, owner: "orchestrator", age: 22 },
  { key: "ISS-1091", title: "A confirmed-fixed notice for a read-only request carries no result", state: "Open", wait: "Master · dispatch a run", eta: 8 * 24 * 60, owner: null, age: 60 },
  { key: "ISS-1097", title: "forge-dev deploys as a docker-compose Coolify app, which Coolify recreates", state: "Open", wait: "Master · dispatch a run", eta: 8 * 24 * 60, owner: "orchestrator", age: 240 },
];
const CLOCK = { lang: "en" as const, now: NOW, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };

function IssueRows() {
  const fold = useGroupFold("witness:names-whole");
  const view = (r: Row): ListRowView => ({
    key: r.key,
    href: `#${r.key}`,
    title: r.title,
    facts: [],
    state: <StatusChip tone={r.state.startsWith("In") ? "run" : "ready"} label={r.state} />,
    waitingOn: <span className="truncate text-13">{r.wait}</span>,
    eta: <EtaCell eta={r.eta === null ? null : { kind: "range", p50At: new Date(NOW + r.eta * 60_000).toISOString(), p85At: new Date(NOW + r.eta * 90_000).toISOString(), tail: null, detail: "" }} clock={CLOCK} />,
    owner: r.owner ? <ActorChip name={r.owner} kind="human" size={20} /> : <span className="text-subtle">Unassigned</span>,
    age: { text: r.age < 60 ? `${r.age}m` : `${Math.round(r.age / 60)}h`, title: "" },
  });
  return (
    <GroupedList
      ariaLabel="Issues"
      groups={[
        { id: "moving", label: "Moving", tone: "run", rows: ROWS.slice(0, 2) },
        { id: "queued", label: "Queued", tone: "ready", rows: ROWS.slice(2) },
      ]}
      fold={fold}
      row={view}
      selected={null}
      onPeek={() => {}}
      eta={{ label: "ETA" }}
      keyColumn={false}
    />
  );
}

// ── Project settings › People: dev.571's members and its share links, the last with no title ──
const PROJECT = "p-forge";
const AT = "2026-10-15T08:00:00.000Z";
const MEMBERS = [
  { userId: "a-forge", name: "forge", agent: true, email: "forge.5882f10d89d3@agents.forge.invalid", role: "admin", createdAt: AT },
  { userId: "a-steward", name: "steward", agent: true, email: "steward.65f7ff153027@agents.forge.invalid", role: "viewer", createdAt: AT },
  { userId: "u-qa", name: "qa@forge-dev.sidcorp.co", agent: false, email: "qa@forge-dev.sidcorp.co", role: "member", createdAt: AT },
  { userId: "u-orch", name: "orchestrator@forge-dev.sidcorp.co", agent: false, email: "orchestrator@forge-dev.sidcorp.co", role: "admin", createdAt: AT },
];
const share = (id: string, title: string | null, subjectKind: ShareLinkView["subjectKind"], createdBy: string): ShareLinkView => ({
  id,
  projectId: PROJECT,
  audience: "members",
  subjectKind,
  title,
  createdBy,
  createdAt: AT,
  expiresAt: new Date(NOW + 9 * 86_400_000).toISOString(),
  revokedAt: null,
  revokedBy: null,
  viewCount: 2,
  lastViewedAt: ago(29 * 24 * 60),
});
const SHARES = [share("s1", "Release 0.4.0-dev.268", "release", "a-forge"), share("s2", "Run the progress report template for this week", "message", "u-orch"), share("s3", null, "message", "u-orch")];
const PEOPLE: [QueryKey, unknown][] = [
  [["project", PROJECT, "members"], MEMBERS],
  [["project", PROJECT, "invitations"], []],
  [["project", PROJECT, "shares"], SHARES],
  [["projects", "all"], []],
];

// ── Projects, as the list view draws them ──
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

interface Page {
  name: string;
  path: string;
  pattern?: string;
  render: () => ReactNode;
}
const P = "/projects/hop";
const PAGES: Page[] = [
  { name: "issue-long-title", path: `${P}/issues/ISS-1`, render: () => <Seeded data={ISSUE_LONG}><IssueDetailScreen projectId="p1" slug="hop" id="i1" /></Seeded> },
  { name: "issue-rows", path: `${P}/issues`, render: () => <IssueRows /> },
  {
    name: "settings-people",
    path: `${P}/settings`,
    render: () => (
      <Seeded data={PEOPLE}>
        <div className="px-8 py-6">
          <MembersTab projectId={PROJECT} canEdit={false} />
          <ShareSettings projectId={PROJECT} isAdmin={false} />
        </div>
      </Seeded>
    ),
  },
  { name: "projects", path: "/projects", pattern: "/projects", render: () => <div className="px-8 py-6"><ProjectList items={PROJECTS} now={NOW} spend={false} onTogglePin={() => {}} /></div> },
  { name: "feedback", path: `${P}/feedback`, render: () => <Seeded data={FEEDBACK_TITLED}><FeedbackScreen projectId={FB_P} slug="hop" /></Seeded> },
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
  if (!p) return null;
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
const cut = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 0.5;
const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** What is wrong on each page, by what the QA read on dev.571. */
function wrongOn(name: string): string[] {
  const out: string[] = [];
  if (name === "issue-long-title") {
    const title = q("[data-testid=issue-title]");
    const acts = q("header > div:nth-child(2)");
    if (title && title.getClientRects().length && acts && acts.getBoundingClientRect().width > 0) {
      const text = document.createRange();
      text.selectNodeContents(title);
      const right = Math.max(...[...text.getClientRects()].map((r) => r.right));
      const edge = acts.getBoundingClientRect().left;
      if (right > edge + 0.5) out.push(`the title runs ${Math.round(right - edge)} px under the bar's acts`);
    }
  }
  if (name === "issue-rows") {
    for (const row of all("[data-testid=list-row]")) {
      for (const el of row.querySelectorAll<HTMLElement>("[data-testid=person-chip] span")) {
        if (el.textContent?.trim() === "orchestrator" && cut(el)) out.push(`${row.dataset.key}: the owner reads cut, "orchestrator" in ${el.clientWidth} px`);
      }
    }
  }
  if (name === "settings-people") {
    if (document.body.innerText.includes("agents.forge.invalid")) out.push("an agent reads as its minted address");
    for (const t of all("[data-testid=share-title]")) if (!t.innerText.trim()) out.push(`share ${t.closest("tr")?.dataset.shareId} has no name`);
    if (all("[data-testid=share-title]").length < SHARES.length) out.push("a share row draws no name");
  }
  if (name === "projects") {
    for (const th of document.querySelectorAll<HTMLTableCellElement>("th")) if (!th.innerText.trim() && th.cellIndex > 0) out.push(`column ${th.cellIndex + 1} has no header`);
    for (const row of all("tbody tr")) {
      const marks = [...row.querySelectorAll<HTMLElement>("td:last-child div > span")];
      for (let i = 1; i < marks.length; i++) {
        const [a, b] = [marks[i - 1], marks[i]] as [HTMLElement, HTMLElement];
        if (overlap(a.getBoundingClientRect(), b.getBoundingClientRect())) out.push(`a Team avatar "${b.innerText}" lies over "${a.innerText}"`);
      }
    }
  }
  if (name === "feedback") {
    const named = all("button").filter((b) => /feedback/i.test(b.getAttribute("aria-label") ?? b.innerText) && b.getBoundingClientRect().width > 0);
    if (named.length > 1) out.push(`the header has ${named.length} feedback buttons: ${named.map((b) => `"${b.innerText.trim() || b.getAttribute("aria-label")}"`).join(", ")}`);
  }
  return [...new Set(out)].slice(0, 8);
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
        await pause(1200);
        const threw = q("[data-witness=threw]");
        if (threw) return [`the ${p.name} page threw: ${threw.innerText.slice(0, 300)}`];
        const { count, words } = firstScreenWords(q("[data-witness=page]") as HTMLElement);
        console.log(`WORDS ${p.name} ${t} ${window.innerWidth} ${count} :: ${words.slice(0, 300).join(" ")}`);
        if (count < 5) return [`the ${p.name} page drew ${count} words: it did not draw its screen`];
        return wrongOn(p.name);
      },
    })),
  ),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })}>
    <Shell />
  </QueryClientProvider>,
);

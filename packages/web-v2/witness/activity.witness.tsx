// The workspace Activity page (ISS-979, the owner's mockup v3), over the mockup's own fourteen projects,
// mounted in the workspace column at 1440 and 420, light and dark, with each popover open: a batch, a
// release, a pin and the You count, and one mark's hover summary. Each stage reads that `main` never
// scrolls sideways (the lanes scroll in their own frame), that every lane starts 32px in, under its
// group's label, and that every text it draws meets WCAG AA against what is behind it; it prints the
// first screen's words (`WORDS activity <stage> <n>`).
//
//   pnpm --filter web-v2 witness witness/activity.witness.tsx --out <dir>

import type { OrgActivity, OrgActivityPerson, OrgActivityProject, OrgActivityStanding } from "@forge/contracts/org-activity";
import { ORG_ACTIVITY_GROUPS } from "@forge/contracts/org-activity";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { WORKSPACE_MAIN, WORKSPACE_PAGE_COLUMN } from "@/design/templates/workspace-frame";
import { ActivityScreen } from "@/features/activity";
import { ActiveOrgProvider } from "@/features/orgs";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import "./entry";
import { firstScreenWords } from "./first-screen";
import { InRouter } from "./router";

const ORG = "0d1b2c3d-0000-4000-8000-000000000001";
const NOW = Date.now();
const END = 9 * 60 + 11;
/** A mockup clock time as an instant, its 09:11 being now. */
const at = (hm: string) => {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  return new Date(NOW - (END - (h * 60 + m)) * 60_000).toISOString();
};
const FROM = new Date(NOW - 120 * 60_000).toISOString();
const clampFrom = (iso: string) => (iso < FROM ? FROM : iso);

type Move = [string, string, string, string];
type Rel = [string, string, "released" | "releasing" | "failed", [string, string][], number?];
type Wait = [string, [string, string, OrgActivityPerson["group"]][]];
interface Mock {
  n: string;
  s: OrgActivityStanding;
  q: number;
  ago: number | null;
  runs: [string, string, 1?][];
  b: [string, Move[]][];
  r: Rel[];
  y: Wait[];
}

// the mockup's data (activity-redesign-mockup-v3.html), statuses in Forge's own words
const P: Mock[] = [
  { n: "Forge", s: "working", q: 43, ago: 180, runs: [["07:05", "07:52"], ["08:20", "09:04"], ["09:05", "09:11", 1]],
    b: [["07:24", [["ISS-967", "Reopened issue held by its old release", "in_progress", "awaiting_release"], ["ISS-968", "Sweep loops on a held head", "open", "in_progress"]]],
      ["08:06", [["ISS-971", "Pass on a release counts after a reopen", "in_progress", "awaiting_release"], ["ISS-969", "Rooms read lists its threads", "open", "in_progress"], ["ISS-970", "Hold says no release shipped wrongly", "open", "in_progress"]]],
      ["08:58", [["ISS-972", "Steward token minted twice", "in_progress", "awaiting_release"], ["ISS-977", "Support turn never retried", "open", "in_progress"], ["ISS-978", "Old-runner login sentence", "in_progress", "awaiting_release"], ["ISS-975", "Requirement judge cannot sign in", "draft", "open"]]]],
    r: [["07:40", "0.4.0-dev.499", "released", [["ISS-967", "Reopened issue held by its old release"]]], ["08:31", "0.4.0-dev.501", "released", [["ISS-971", "Pass on a release counts after a reopen"], ["ISS-968", "Sweep loops on a held head"]]], ["09:02", "0.4.0-dev.503", "releasing", [["ISS-972", "Steward token minted twice"], ["ISS-978", "Old-runner login sentence"]]]],
    y: [["08:40", [["ISS-976", "Bind the owner's chat account to Forge", "answer"], ["REQ-35", "Accept revision r4", "approve"], ["ISS-951", "Workspace Activity: pick A or B", "answer"]]]] },
  { n: "epod", s: "working", q: 9, ago: 60, runs: [["07:30", "08:10"], ["08:35", "09:11", 1]],
    b: [["07:50", [["ISS-54", "Search reindex on import", "in_progress", "awaiting_release"], ["ISS-69", "Health lines dropped from logs", "in_progress", "awaiting_release"]]], ["08:50", [["ISS-70", "Variant images keep order", "open", "in_progress"]]]],
    r: [["08:43", "1.38.0", "released", [["ISS-62", "Fastionee variants keep ids"], ["ISS-59", "Storefront filter"], ["ISS-66", "Theme preview"], ["ISS-67", "Fewer log lines"], ["ISS-50", "Order export"], ["ISS-57", "Draft orders"]], 12]], y: [] },
  { n: "Agenfold", s: "working", q: 4, ago: 120, runs: [["07:10", "07:45"], ["08:15", "08:40"], ["09:00", "09:11", 1]],
    b: [["07:20", [["ISS-162", "Spend label per row", "in_progress", "awaiting_release"]]], ["08:25", [["ISS-163", "Folded key captions", "awaiting_release", "in_progress"], ["ISS-164", "Phone spend label", "open", "in_progress"], ["ISS-165", "Keys menu", "open", "in_progress"]]]],
    r: [["07:30", "0.133.0", "released", [["ISS-162", "Spend label per row"]]]], y: [] },
  { n: "AdminHub API", s: "working", q: 7, ago: 300, runs: [["07:40", "08:30"], ["08:50", "09:11", 1]],
    b: [["08:05", [["ISS-32", "Virtual machine keys optional", "in_progress", "awaiting_release"], ["ISS-103", "PHP source served at the root", "open", "in_progress"]]]], r: [],
    y: [["08:55", [["ISS-103", "Promote the image fix to both hubs", "approve"]]]] },
  { n: "AdminHub FE", s: "idle", q: 4, ago: 3600, runs: [], b: [], r: [], y: [["07:15", [["ISS-88", "Bulk edit: keep or drop the old modal", "answer"], ["ISS-91", "Order table columns", "answer"]]]] },
  { n: "Orbit", s: "idle", q: 3, ago: 1080, runs: [["07:55", "08:35"]], b: [["08:20", [["ISS-55", "Feedback reaches Forge dev", "in_progress", "awaiting_release"], ["ISS-17", "Coolify reads unhealthy", "open", "dropped"]]]],
    r: [["08:52", "0.40.0", "released", [["ISS-55", "Feedback reaches Forge dev"]]]], y: [] },
  { n: "Catalog API", s: "idle", q: 11, ago: 540, runs: [["07:35", "08:05"], ["08:40", "09:00"]], b: [["08:10", [["ISS-41", "Price sync retries", "in_progress", "awaiting_release"]]]],
    r: [["08:15", "2.4.1", "failed", [["ISS-41", "Price sync retries"]]]], y: [] },
  { n: "SidDesk", s: "idle", q: 5, ago: 1320, runs: [["07:20", "07:50"]], b: [["07:45", [["ISS-12", "Chat verbs in CLI", "awaiting_release", "closed"]]]],
    r: [["07:48", "0.9.0", "released", [["ISS-12", "Chat verbs in CLI"]]]], y: [["08:30", [["ISS-14", "Passwords for the QA agent", "answer"]]]] },
  { n: "Catalog FE", s: "idle", q: 3, ago: 10800, runs: [], b: [], r: [], y: [["07:05", [["REQ-9", "Accept the desktop-only scope", "accept"]]]] },
  { n: "forge-plugin", s: "idle", q: 7, ago: 1500, runs: [["08:45", "09:00"]], b: [["08:55", [["ISS-59", "Judge-login wording", "open", "in_progress"]]]], r: [], y: [] },
  { n: "Mowment", s: "paused", q: 6, ago: 2400, runs: [["07:10", "07:40"]], b: [["07:35", [["ISS-3", "Onboarding copy", "in_progress", "awaiting_release"], ["ISS-4", "Plan picker", "in_progress", "awaiting_release"]]]], r: [], y: [] },
  { n: "Pixelight", s: "paused", q: 2, ago: 3120, runs: [["07:25", "07:55"]], b: [], r: [], y: [] },
  { n: "Eco A", s: "none", q: 1, ago: null, runs: [], b: [], r: [], y: [] },
  { n: "Autoflow", s: "none", q: 0, ago: null, runs: [], b: [], r: [], y: [] },
];

const STATE = { working: "in_pass", idle: "idle", paused: "silent", none: "none" } as const;

const projectOf = (p: Mock, i: number): OrgActivityProject => {
  const waits = p.y.map(([t, list]) => ({
    at: clampFrom(at(t)),
    items: list.map(([key, title, group]): OrgActivityPerson => ({ decisionId: `d-${key}`, group, key, title, since: at(t), opens: null })),
    more: 0,
  }));
  const items = waits.flatMap((w) => w.items);
  return {
    projectId: `p-${i}`,
    slug: `s-${i}`,
    name: p.n,
    group: items.length ? "you" : p.s,
    standing: p.s,
    pause: p.s === "paused" ? "silent" : null,
    master: { state: STATE[p.s], since: null, lastPassEndedAt: null, lastBeatAt: null, silentAfterSeconds: 300, pane: null, doing: p.s === "working" ? { kind: "pass", verb: "dispatch", issueKey: "ISS-1", issueTitle: "Sweep loops on a held head" } : null, dialog: null },
    now: [],
    next: { total: p.q, items: [], skip: p.s === "idle" && p.q > 0 ? "one_at_a_time" : null },
    people: { total: items.length, items },
    peoplePending: false,
    release: null,
    releasePending: false,
    // AdminHub API's release was cut and is deploying (ISS-1051): its release column shows the run
    releasing: p.n === "AdminHub API" ? { version: "0.14.0", stage: "deploying", since: at("08:58") } : null,
    awaitingRelease: 0,
    lane: {
      from: FROM,
      runs: p.runs.map(([a, b, live]) => ({ from: clampFrom(at(a)), to: live ? null : at(b) })).filter((r) => r.to === null || r.to > FROM),
      batches: p.b.filter(([t]) => at(t) >= FROM).map(([t, moves]) => ({ at: at(t), moves: moves.map(([issueKey, title, from, to]) => ({ issueKey, title, from: from as never, to: to as never })) })),
      releases: p.r.filter(([t]) => at(t) >= FROM).map(([t, version, state, issues, total]) => ({ at: at(t), version, state, total: total ?? issues.length, issues: issues.map(([key, title]) => ({ key, title })) })),
      waits,
    },
    lastActivityAt: p.ago === null ? null : new Date(NOW - p.ago * 1000).toISOString(),
  };
};

const projects = P.map(projectOf).sort((a, b) => ORG_ACTIVITY_GROUPS.indexOf(a.group) - ORG_ACTIVITY_GROUPS.indexOf(b.group));
const READ: OrgActivity = {
  generatedAt: new Date(NOW).toISOString(),
  orgId: ORG,
  projects,
  refreshing: false,
  totals: { projects: projects.length, ...(Object.fromEntries(ORG_ACTIVITY_GROUPS.map((g) => [g, projects.filter((p) => p.group === g).length])) as Record<(typeof ORG_ACTIVITY_GROUPS)[number], number>) },
};

/** AdminHub API's cleanup (ISS-1051): a window on, two debts open, a red report clearing one of three. */
const DEBT = (id: string, where: string, cleared: boolean) => ({
  id,
  issueId: null,
  issueKey: null,
  kind: "debt",
  check: null,
  where,
  detail: `Left behind in ${where}`,
  impact: { type: "logic", rating: "low", reason: "contained" },
  recordedBy: null,
  recordedAt: at("07:00"),
  cleared: cleared ? { reportId: "r-1", how: "split the module", at: at("06:30") } : null,
  carried: null,
  evidence: [],
});
const LEDGER_ON = {
  fast: true,
  open: [DEBT("d-2", "src/orders/export.ts", false), DEBT("d-3", "src/catalog/sync.ts", false)],
  cleared: [DEBT("d-1", "src/auth/session.ts", true)],
  waiting: [],
  window: { scheduleId: "sch-1", cron: "0 18 * * *", timeZone: null, enabled: true, nextRunAt: new Date(NOW + 9 * 3_600_000).toISOString() },
  windowOff: null,
};
const REPORTS_ON = [
  {
    id: "r-1",
    fireId: null,
    base: { branch: "dev", sha: "a".repeat(40) },
    result: "red",
    ci: null,
    cleared: [{ debt: "d-1", how: "split the module" }],
    remains: [
      { debt: "d-2", why: "needs the export rewrite" },
      { debt: "d-3", why: "waits on the sync contract" },
    ],
    covers: [],
    reportedBy: null,
    reportedAt: new Date(NOW - 15 * 3_600_000).toISOString(),
    supersededBy: null,
  },
];
/** AdminHub FE: no window on, nothing recorded. */
const LEDGER_OFF = { fast: true, open: [], cleared: [], waiting: [], window: null, windowOff: "No cleanup window is on for this project." };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/** Every call the page sent, printed as `CALLS activity <n>` with the words. */
const sent: string[] = [];
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  sent.push(path);
  // the one live-run count the rail, Projects, Agents and Activity read (ISS-1069): Forge and epod run
  if (path === "/projects/health") return json([{ id: "p-0", liveRuns: 2 }, { id: "p-1", liveRuns: 1 }]);
  if (path === `/orgs/${ORG}/activity`) return json(READ);
  if (path === "/orgs") return json([{ id: ORG, slug: "sidcorp", name: "SidCorp", isPersonal: false, role: "owner" }]);
  if (path === "/auth/me/preferences") return json({ activeOrgId: ORG });
  if (path === "/projects") return json([]);
  if (path === "/projects/p-3/debts") return json(LEDGER_ON);
  if (path === "/projects/p-3/cleanup-reports") return json({ reports: REPORTS_ON });
  if (path === "/projects/p-4/debts") return json(LEDGER_OFF);
  if (path === "/projects/p-4/cleanup-reports") return json({ reports: [] });
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
  return main.scrollWidth <= main.clientWidth ? [] : [`main scrolls sideways: ${main.scrollWidth} px in ${main.clientWidth}`];
}

/**
 * On a phone the whole axis is in view and the header's time reads whole (ISS-1072 round 2): the frame
 * opened at its now end with three quarters of its marks off to the left, and the time read "10:2".
 */
function phoneReads(): string[] {
  if (window.innerWidth >= 768) return [];
  const wrong: string[] = [];
  const frame = q("[data-testid=timeline-frame]");
  if (frame && frame.scrollWidth > frame.clientWidth + 1) wrong.push(`the lanes scroll sideways on a phone: ${frame.scrollWidth} px in ${frame.clientWidth}`);
  const box = frame?.getBoundingClientRect();
  for (const m of document.querySelectorAll<HTMLElement>("[data-testid=timeline-frame] [data-testid^=mark-]")) {
    const r = m.getBoundingClientRect();
    if (box && r.width > 0 && (r.right < box.left + 124 || r.left > box.right)) wrong.push(`a ${m.dataset.testid} sits out of view, ${Math.round(r.left)}–${Math.round(r.right)} px in a ${Math.round(box.left)}–${Math.round(box.right)} px frame`);
  }
  const live = q("[data-testid=activity-live]");
  const cut = live?.parentElement;
  if (live && cut) {
    // the text's own extent, which a clipping box does not shorten
    const text = document.createRange();
    text.selectNodeContents(live);
    let edge = q("[data-testid=activity-view]")?.getBoundingClientRect().left ?? window.innerWidth;
    for (let el: HTMLElement | null = cut; el; el = el.parentElement) if (getComputedStyle(el).overflowX !== "visible") edge = Math.min(edge, el.getBoundingClientRect().right);
    const over = text.getBoundingClientRect().right - edge;
    if (over > 0.5) wrong.push(`the header's time is cut ${Math.round(over)} px short: "${live.textContent}"`);
  }
  // the time's sentence last in the list, never cut off by the marks' count
  const time = wrong.filter((w) => w.startsWith("the header's time"));
  return [...wrong.filter((w) => !time.includes(w)).slice(0, 6), ...time];
}

/**
 * No two marks of a lane cover each other and no two axis labels print over each other, at every width
 * (ISS-1072 round 3): at 390 the "15:00" and "now" labels overlapped and batch circles sat on release
 * diamonds, the marks spread for a 590px track the phone does not have.
 */
function apart(): string[] {
  const wrong: string[] = [];
  const hit = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const axis = q("[data-testid=timeline-axis]");
  const labels = [...(axis?.querySelectorAll<HTMLElement>("[data-testid=axis-label]") ?? [])].filter((l) => l.checkVisibility());
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const [a, b] = [labels[i], labels[j]] as [HTMLElement, HTMLElement];
      if (hit(a.getBoundingClientRect(), b.getBoundingClientRect())) wrong.push(`axis labels "${a.textContent}" and "${b.textContent}" print over each other`);
    }
  }
  for (const row of document.querySelectorAll<HTMLElement>("[data-testid=list-row]")) {
    // each mark's own box, unrotated: a pin's or a diamond's rotated box is wider than the shape it draws
    const marks = [...row.querySelectorAll<HTMLElement>("[data-testid=timeline-track] > button")].map((m) => ({ m, r: m.getBoundingClientRect() }));
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const [a, b] = [marks[i], marks[j]] as [(typeof marks)[number], (typeof marks)[number]];
        if (hit(a.r, b.r)) wrong.push(`in ${row.dataset.key}, a ${a.m.dataset.testid} sits on a ${b.m.dataset.testid}`);
      }
    }
  }
  return [...new Set(wrong)].slice(0, 8);
}

/** Every lane starts 32px into the frame as it shows, where its group's label starts: on a phone the frame opens scrolled to now, its lead column held in place. */
function indented(): string[] {
  const frame = q("[data-testid=timeline-frame]");
  if (!frame) return ["no lanes drawn"];
  const left = frame.getBoundingClientRect().left;
  const wrong: string[] = [];
  for (const g of document.querySelectorAll<HTMLElement>("[data-testid=activity-group]")) {
    const label = g.querySelector<HTMLElement>("[data-testid=group-label]")?.getBoundingClientRect().left ?? 0;
    for (const row of g.querySelectorAll<HTMLElement>("[data-testid=list-row]")) {
      const lead = row.querySelector<HTMLElement>("[data-testid=activity-name]")?.getBoundingClientRect().left ?? 0;
      if (Math.round(lead - left) !== 32) wrong.push(`a lane starts ${Math.round(lead - left)} px in, not 32`);
      if (Math.abs(lead - label) > 1) wrong.push(`a lane starts ${Math.round(lead - label)} px off its group's label`);
    }
  }
  return [...new Set(wrong)];
}

const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
/** A CSS colour as sRGB, whatever space it is written in. */
function rgba(color: string): [number, number, number, number] {
  if (!probe) return [0, 0, 0, 1];
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return [r ?? 0, g ?? 0, b ?? 0, (a ?? 0) / 255];
}
const lum = ([r, g, b]: number[]) => {
  const c = [r, g, b].map((v) => {
    const s = (v ?? 0) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
};
function behind(el: HTMLElement): [number, number, number] {
  for (let a: HTMLElement | null = el; a; a = a.parentElement) {
    const c = rgba(getComputedStyle(a).backgroundColor);
    if (c[3] > 0.5) return [c[0], c[1], c[2]];
  }
  return [255, 255, 255];
}

/** Each text the page or its popover draws, against what is behind it: 4.5:1, or 3:1 for large text. */
function contrast(scope: string): string[] {
  const wrong = new Set<string>();
  for (const root of document.querySelectorAll<HTMLElement>(scope)) {
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      if (!own || el.closest("[aria-hidden=true]")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const st = getComputedStyle(el);
      const fg = rgba(st.color);
      const bg = behind(el);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
      const ratio = (hi + 0.05) / (lo + 0.05);
      const large = Number.parseFloat(st.fontSize) >= 24 || (Number.parseFloat(st.fontSize) >= 18.66 && Number(st.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) wrong.add(`"${el.textContent?.trim().slice(0, 30)}" reads ${ratio.toFixed(2)}:1`);
    }
  }
  return [...wrong].slice(0, 8);
}

const words = (name: string) => {
  const column = q("[data-witness=page]");
  if (!column) return;
  const { count, words: w } = firstScreenWords(column);
  console.log(`WORDS activity ${name} ${count} :: ${w.join(" ")}`);
  console.log(`CALLS activity ${sent.length} :: ${sent.join(" | ")}`);
};

const closePop = async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  (document.activeElement as HTMLElement | null)?.blur();
  await pause(250);
};

/** Opens a mark's popover, scrolled into the window. */
const openPop = async (sel: string, nth: number) => {
  await closePop();
  const mark = [...document.querySelectorAll<HTMLElement>(sel)].at(nth);
  if (!mark) return [`no ${sel} to open`];
  mark.scrollIntoView({ block: "center", inline: "center" });
  await pause(150);
  mark.click();
  await pause(450);
  return q("[data-testid=mark-pop]") ? [] : [`${sel} opened no popover`];
};

const look = (t: "light" | "dark") => ({
  name: `page-${t}`,
  run: async () => {
    await closePop();
    theme(t);
    q("main")?.scrollTo(0, 0);
    await pause(500);
    words(`page-${t}`);
    return [...sideways(), ...indented(), ...phoneReads(), ...apart(), ...contrast("[data-witness=page]")];
  },
});

const popStage = (name: string, sel: string, t: "light" | "dark", nth = 0) => ({
  name: `${name}-${t}`,
  run: async () => {
    theme(t);
    const wrong = await openPop(sel, nth);
    return [...wrong, ...sideways(), ...contrast("[data-testid=mark-pop]")];
  },
});

/** Opens a project's peek by its name, and measures what the peek draws. */
const peekStage = (slug: string, t: "light" | "dark", name: string, open: string[] = []) => ({
  name: `${name}-${t}`,
  run: async () => {
    await closePop();
    theme(t);
    const project = q(`[data-testid=list-row][data-key=${slug}] [data-testid=activity-name]`)?.textContent ?? "";
    const shown = q("[data-testid=activity-peek]");
    // a click on the name of the project already open closes its peek
    if (!shown?.textContent?.includes(project)) {
      const link = q(`[data-testid=list-row][data-key=${slug}] [data-testid=activity-name]`);
      if (!link) return [`no ${slug} to open`];
      link.click();
    }
    await pause(600);
    const peek = q("[data-testid=activity-peek]");
    if (!peek) return [`${slug} opened no peek`];
    for (const sel of open) {
      const toggle = peek.querySelector<HTMLElement>(sel);
      if (!toggle) return [`the peek has no ${sel}`];
      toggle.click();
      await pause(300);
    }
    peek.scrollTo?.(0, peek.scrollHeight);
    for (const el of peek.querySelectorAll<HTMLElement>("*")) if (el.scrollHeight > el.clientHeight + 4) el.scrollTo(0, el.scrollHeight);
    await pause(250);
    const { count, words: w } = firstScreenWords(peek, { whole: true });
    console.log(`WORDS activity ${name}-${t} ${count} :: ${w.join(" ")}`);
    return [...sideways(), ...contrast("[data-testid=activity-peek]")];
  },
});

window.__witness = {
  cases: [
    { name: "wide-1440", width: 1440 },
    { name: "phone-420", width: 420 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(q("[data-testid=mark-batch]") && q("[data-testid=mark-wait]")),
  stages: [
    look("light"),
    look("dark"),
    ...(["light", "dark"] as const).flatMap((t) => [
      popStage("batch", "[data-testid=list-row][data-key=s-0] [data-testid=mark-batch]", t, -1),
      popStage("release", "[data-testid=list-row][data-key=s-1] [data-testid=mark-release]", t),
      popStage("wait", "[data-testid=list-row][data-key=s-0] [data-testid=mark-wait]", t),
      popStage("you", "[data-testid=list-row][data-key=s-0] [data-testid=activity-you]", t),
    ]),
    {
      name: "hover-light",
      run: async () => {
        await closePop();
        theme("light");
        const mark = q("[data-testid=list-row][data-key=s-1] [data-testid=mark-batch]");
        if (!mark) return ["no batch to hover"];
        mark.scrollIntoView({ block: "center", inline: "center" });
        mark.focus();
        await pause(300);
        const tip = mark.querySelector<HTMLElement>("[data-testid=timeline-tip]");
        return tip && getComputedStyle(tip).display !== "none" ? [] : ["a focused batch shows no summary"];
      },
    },
    ...(["light", "dark"] as const).flatMap((t) => [
      peekStage("s-3", t, "peek-releasing"),
      peekStage("s-3", t, "peek-cleanup-open", ["[data-testid=cleanup-report] summary", "[data-testid=cleanup-debts] summary"]),
      peekStage("s-4", t, "peek-cleanup-off"),
    ]),
    {
      name: "releases-only-light",
      run: async () => {
        await closePop();
        const releases = [...document.querySelectorAll<HTMLElement>("[data-testid=activity-view] button")].find((b) => b.textContent === "Releases");
        releases?.click();
        q("main")?.scrollTo(0, 0);
        await pause(500);
        return q("[data-testid=mark-batch]") ? ["Releases still draws batches"] : sideways();
      },
    },
  ],
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <InRouter at="/activity" pattern="/activity">
    <QueryClientProvider client={client}>
      <ActiveOrgProvider>
        <TopBarSlotProvider>
          <div className="flex h-screen bg-app text-fg">
            <div className={WORKSPACE_PAGE_COLUMN} data-witness="page">
              <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
              <main className={WORKSPACE_MAIN}>
                <ActivityScreen />
              </main>
            </div>
          </div>
        </TopBarSlotProvider>
      </ActiveOrgProvider>
    </QueryClientProvider>
  </InRouter>,
);

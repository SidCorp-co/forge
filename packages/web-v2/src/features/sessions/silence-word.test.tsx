// @vitest-environment jsdom
//
// One running session, in each of its two states. Silent ninety seconds, every surface that shows it
// names that silence with the Pipeline page's word, in the Pipeline page's tone, and none of them
// claims it is working. Checking in, every surface calls it Working. A surface with its own word for
// either state goes red here.

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_META, lastReported, SILENCE_WORD, WORKING_WORD } from "@/design";
import type { StatusKey } from "@/design/status";
import { RunRow } from "@/features/agents/components/run-row";
import type { RunSessionRow } from "@/features/agents/types";
import { SessionsList } from "@/features/pipeline/components/sessions-list";
import type { LiveSession } from "@/features/pipeline/types";
import { LiveSessionsCard } from "@/features/project-dashboard/components/live-sessions-card";
import { TurnStage, sessionTurnStage } from "@/features/session/components/turn-stage";
import { FleetStrip } from "./components/fleet-strip";
import { SessionChip } from "./components/session-chip";
import { SessionsScreen } from "./components/sessions-screen";
import { deriveSessionDisplayStatus, type SessionRow, statusToChip } from "./types";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/projects/pair/agents" }));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({
    data: { devicePool: [{ id: "d1", name: "box-a", platform: "linux", status: "online" }], defaultDeviceId: "d1" },
  }),
  useProjects: () => ({ data: [{ id: "p1", slug: "pair", name: "Pair", role: "owner" }] }),
  useOrgScopedProjects: () => ({ projects: [], projectIds: new Set(["p1"]) }),
}));
vi.mock("@/features/runners/hooks", () => ({
  useDevices: () => ({ data: [] }),
  useProjectRunners: () => ({
    data: [{ runnerId: "r-d1", deviceId: "d1", deviceName: "box-a", platform: "linux", deviceStatus: "online", runnerStatus: "online", limitReason: null }],
    isError: false,
    error: null,
  }),
  useActiveRunners: () => ({ data: { runners: [], busy: 0 }, isError: false, error: null }),
}));
vi.mock("@/features/pipeline/hooks", () => ({
  // The silent session is live on box-a, so the strip counts it there as the dashboard does.
  useSessionsAndHolds: () => ({
    data: { sessions: [{ id: "s-silent", deviceId: "d1" }], holds: [], readAt: "" },
    isError: false,
    error: null,
  }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
const { mutation } = vi.hoisted(() => ({ mutation: () => ({ mutate: () => {}, isPending: false }) }));
vi.mock("./hooks", () => ({
  useQueueStats: () => ({ data: { devices: [] } }),
  useSessions: () => ({ data: { items: [listed], totalCount: 1 }, isLoading: false, isError: false }),
  useCancelSession: mutation,
  useRetrySession: mutation,
  useRerunSession: mutation,
  useAbortSession: mutation,
  useSweepZombies: mutation,
}));

const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const SILENT_SINCE = new Date(NOW - 90_000).toISOString();
const HEARD_AT = new Date(NOW - 10_000).toISOString();
const STARTED = new Date(NOW - 30 * 60_000).toISOString();

const live: LiveSession = {
  id: "s1",
  kind: "run_session",
  title: "run: ISS-3",
  status: "running",
  runtimeState: "working",
  deviceId: "d1",
  deviceName: "box-a",
  parentSessionId: null,
  startedAt: STARTED,
  lastHeartbeatAt: SILENT_SINCE,
  createdAt: STARTED,
  issues: [],
  report: null,
};

const row: SessionRow = {
  id: "s1",
  projectId: "p1",
  userId: null,
  deviceId: "d1",
  pipelineRunId: "r1",
  title: "run: ISS-3",
  repoPath: null,
  status: "running",
  kind: "run_session",
  usage: null,
  metadata: { type: "run_session" },
  failureReason: null,
  dispatchedAt: null,
  startedAt: STARTED,
  lastHeartbeatAt: SILENT_SINCE,
  createdAt: STARTED,
  updatedAt: SILENT_SINCE,
};

const run: RunSessionRow = {
  runId: "r1",
  projectId: "p1",
  sessionId: "s1",
  masterSessionId: null,
  pid: 4242,
  worktreePath: "/w/iss-3",
  bootId: "b1",
  incarnation: "live",
  work: "runnable",
  blockerKind: null,
  waitingOn: null,
  sessionTerminalAt: null,
  worktreeGoneAt: null,
  issues: [],
  deviceId: "d1",
  deviceName: "box-a",
  observedAt: SILENT_SINCE,
  sessionStatus: "running",
  sessionFailureReason: null,
  lastActivityAt: SILENT_SINCE,
  masterTitle: null,
};

/** The session row the sessions list is handed; each case sets it before rendering the list. */
let listed: SessionRow = row;

/** What a surface says of the silence: its word (before any " · " qualifier) and the ink it is drawn in. */
interface Reading {
  word: string;
  ink: string;
}

function readingOf(el: Element | null | undefined, inkFrom?: Element | null): Reading | undefined {
  if (!el) return undefined;
  return {
    word: (el.textContent ?? "").split(/ · |\. /)[0].replace(/\.$/, "").trim(),
    ink: ((inkFrom ?? el) as HTMLElement).style.color,
  };
}

const spans = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("span")];
const CHECK_IN = /^\S+ · \d+\S* ago$/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a running session gone silent", () => {
  it("is named with the Pipeline page's word and drawn in its tone on every surface that shows it", () => {
    const { container: pipeline } = render(<SessionsList sessions={[live]} slug="pair" now={NOW} />);
    const reference = readingOf(spans(pipeline).find((el) => CHECK_IN.test(el.textContent ?? "")));
    cleanup();

    const { container: chipBox } = render(
      <SessionChip status={statusToChip(deriveSessionDisplayStatus(row, NOW))} />,
    );
    const chip = readingOf(chipBox.firstElementChild);
    cleanup();

    const { container: card } = render(<LiveSessionsCard sessions={[live]} slug="pair" now={NOW} read={{ read: "ok" }} />);
    const dashboard = readingOf(spans(card).find((el) => CHECK_IN.test(el.textContent ?? "")));
    cleanup();

    const { container: fleet } = render(
      <FleetStrip projectId="p1" rows={[row]} displays={[deriveSessionDisplayStatus(row, NOW)]} now={NOW} />,
    );
    // The strip marks a silent box with one inked word beside its step.
    const runnerStrip = readingOf(
      [...fleet.querySelectorAll<HTMLElement>("span.fg-caption")].find((el) => el.style.color && /^\p{L}+$/u.test(el.textContent ?? "")),
    );
    cleanup();

    listed = row;
    const { container: list } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    // The list's summary counts the silent session under the state's word, its figure in the state's ink.
    const stat = [...list.querySelectorAll(".fg-overline")].find(
      (el) => el.nextElementSibling?.textContent === "1" && el.textContent !== WORKING_WORD,
    );
    const listStat = readingOf(stat, stat?.nextElementSibling);
    const listChip = readingOf(list.querySelector("tbody span.rounded-md.font-semibold"));
    cleanup();

    const { container: runs } = render(
      <ul>
        <RunRow row={run} now={NOW} slug="pair" />
      </ul>,
    );
    const agentsRuns = readingOf(spans(runs).find((el) => /No check-in for/.test(el.textContent ?? "") && el.children.length === 0));
    cleanup();

    expect(reference?.word).toBeTruthy();
    expect(reference?.ink).toBeTruthy();
    expect({ chip, dashboard, runnerStrip, listStat, listChip, agentsRuns }).toEqual({
      chip: reference,
      dashboard: reference,
      runnerStrip: reference,
      listStat: reference,
      listChip: reference,
      agentsRuns: reference,
    });
  });

  it("claims no current activity on any surface that shows what it is doing", () => {
    const quietDoing = lastReported(WORKING_WORD);

    const { container: pipeline } = render(<SessionsList sessions={[live]} slug="pair" now={NOW} />);
    const pipelineDoing = doingCell(pipeline);
    cleanup();

    const { container: card } = render(<LiveSessionsCard sessions={[live]} slug="pair" now={NOW} read={{ read: "ok" }} />);
    const dashboardDoing = card.querySelector("li > span")?.textContent;
    cleanup();

    const { container: runs } = render(
      <ul>
        <RunRow row={run} now={NOW} slug="pair" />
      </ul>,
    );
    const runChip = runs.querySelector("li > span")?.textContent;
    cleanup();

    const stage = sessionTurnStage({ live: true, display: deriveSessionDisplayStatus(row, NOW) });
    const { container: page } = render(
      stage ? <TurnStage stage={stage} silentForMs={NOW - Date.parse(SILENT_SINCE)} /> : <span />,
    );
    const pageLine = page.querySelector("[data-testid=turn-stage]");
    const spinning = page.querySelector("[role=status]") !== null;
    cleanup();

    expect({ pipelineDoing, dashboardDoing, runChip, spinning }).toEqual({
      pipelineDoing: quietDoing,
      dashboardDoing: quietDoing,
      runChip: quietDoing,
      spinning: false,
    });
    expect(pageLine?.textContent).toBe("Quiet. Last reported working 1m ago.");
  });
});

describe("a running session that keeps checking in", () => {
  const beatingLive: LiveSession = { ...live, lastHeartbeatAt: HEARD_AT };
  const beatingRow: SessionRow = { ...row, lastHeartbeatAt: HEARD_AT, updatedAt: HEARD_AT };
  const beatingRun: RunSessionRow = { ...run, lastActivityAt: HEARD_AT, observedAt: HEARD_AT };

  it("is called Working on every surface that shows it", () => {
    const { container: pipeline } = render(<SessionsList sessions={[beatingLive]} slug="pair" now={NOW} />);
    const reference = doingCell(pipeline);
    cleanup();

    const { container: card } = render(
      <LiveSessionsCard sessions={[beatingLive]} slug="pair" now={NOW} read={{ read: "ok" }} />,
    );
    const dashboard = card.querySelector("li > span")?.textContent;
    cleanup();

    const { container: chipBox } = render(
      <SessionChip status={statusToChip(deriveSessionDisplayStatus(beatingRow, NOW))} />,
    );
    const chip = chipBox.firstElementChild?.textContent;
    cleanup();

    listed = beatingRow;
    const { container: list } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    const listChip = list.querySelector("tbody span.rounded-md.font-semibold")?.textContent;
    const listStat = [...list.querySelectorAll(".fg-overline")].find(
      (el) => el.nextElementSibling?.textContent === "1",
    )?.textContent;
    const listTab = [...list.querySelectorAll("button")]
      .map((b) => b.textContent ?? "")
      .find((t) => /^(Running|Working)/.test(t))
      ?.replace(/\d+$/, "")
      .trim();
    listed = row;
    cleanup();

    const { container: runs } = render(
      <ul>
        <RunRow row={beatingRun} now={NOW} slug="pair" />
      </ul>,
    );
    const agentsRuns = runs.querySelector("li > span")?.textContent;
    cleanup();

    expect(reference).toBe(WORKING_WORD);
    expect({ dashboard, chip, listChip, listStat, listTab, agentsRuns }).toEqual({
      dashboard: reference,
      chip: reference,
      listChip: reference,
      listStat: reference,
      listTab: reference,
      agentsRuns: reference,
    });
  });
});

/** The Pipeline row's Doing cell, without the field name a phone shows in place of a column header. */
function doingCell(root: ParentNode): string | undefined {
  const cell = [...root.querySelectorAll("div")].find((el) => el.firstElementChild?.textContent === "Doing");
  return cell?.textContent?.replace(/^Doing/, "");
}

describe("the sessions list's count of working sessions (ISS-1228 criterion 36)", () => {
  /** The header figure under a label, and the filter tab whose label opens with it. */
  function readCounts(list: HTMLElement, label: string) {
    const stat = [...list.querySelectorAll(".fg-overline")].find((el) => el.textContent === label);
    const tab = [...list.querySelectorAll("button")]
      .map((b) => b.textContent ?? "")
      .find((t) => t.startsWith(`${label} `));
    return { figure: stat?.nextElementSibling?.textContent, tab: tab?.slice(label.length).trim() };
  }

  it("counts a quiet session in neither the Working figure nor the Working filter", () => {
    listed = row;
    const { container } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    expect(readCounts(container, WORKING_WORD)).toEqual({ figure: "0", tab: "0" });
    cleanup();
  });

  it("counts a session that keeps checking in once in both", () => {
    listed = { ...row, lastHeartbeatAt: HEARD_AT, updatedAt: HEARD_AT };
    const { container } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    expect(readCounts(container, WORKING_WORD)).toEqual({ figure: "1", tab: "1" });
    listed = row;
    cleanup();
  });
});

// ISS-1228 round 15 repair: box-b read Offline in the strip while its session, heard just before the box
// dropped, read Working with a green dot and the header counted no quiet session.
describe("a running session whose box is offline, heard moments before it dropped", () => {
  const offLive: LiveSession = { ...live, lastHeartbeatAt: HEARD_AT, boxOnline: false };
  const offRow: SessionRow = { ...row, lastHeartbeatAt: HEARD_AT, updatedAt: HEARD_AT, boxOnline: false };

  it("reads what it last reported on every surface, never Working", () => {
    const quietDoing = lastReported(WORKING_WORD);
    const { container: pipeline } = render(<SessionsList sessions={[offLive]} slug="pair" now={NOW} />);
    const pipelineDoing = doingCell(pipeline);
    cleanup();

    const { container: card } = render(<LiveSessionsCard sessions={[offLive]} slug="pair" now={NOW} read={{ read: "ok" }} />);
    const dashboardDoing = card.querySelector("li > span")?.textContent;
    cleanup();

    expect({ pipelineDoing, dashboardDoing, display: deriveSessionDisplayStatus(offRow, NOW) }).toEqual({
      pipelineDoing: quietDoing,
      dashboardDoing: quietDoing,
      display: "stalled",
    });
  });

  it("is counted Quiet in the sessions list's header, with its box's dot not green", () => {
    listed = offRow;
    const { container: list } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    const figure = (label: string) =>
      [...list.querySelectorAll(".fg-overline")].find((el) => el.textContent === label)?.nextElementSibling?.textContent;
    const runnerDot = [...list.querySelectorAll<HTMLElement>("tbody span")].find((el) => el.style.borderRadius === "999px");
    const listChip = list.querySelector("tbody span.rounded-md.font-semibold")?.textContent;
    const counted = { working: figure(WORKING_WORD), quiet: figure(SILENCE_WORD), listChip };
    const dot = runnerDot?.style.background;
    listed = row;
    cleanup();

    expect(counted).toEqual({
      working: "0",
      quiet: "1",
      listChip: SILENCE_WORD,
    });
    expect(dot).toBe(HEALTH_META.attention.dot);
  });
});

describe("a running session its box reports blocked (ISS-1228 criteria 34, 40, 42)", () => {
  const report = {
    incarnation: "live",
    work: "blocked",
    blockerKind: "human",
    waitingOn: "approve the database restore in Coolify",
    observedAt: HEARD_AT,
    since: HEARD_AT,
  };
  const blockedLive: LiveSession = { ...live, lastHeartbeatAt: HEARD_AT, report };
  const blockedRow: SessionRow = { ...row, lastHeartbeatAt: HEARD_AT, updatedAt: HEARD_AT, report };
  const quietBlockedRow: SessionRow = { ...row, report };

  it("is called Blocked on every surface that shows it, and counted nowhere as Working", () => {
    const { container: pipeline } = render(<SessionsList sessions={[blockedLive]} slug="pair" now={NOW} />);
    const reference = doingCell(pipeline);
    cleanup();

    const { container: card } = render(
      <LiveSessionsCard sessions={[blockedLive]} slug="pair" now={NOW} read={{ read: "ok" }} />,
    );
    const dashboard = card.querySelector("li > span")?.textContent;
    cleanup();

    const { container: chipBox } = render(
      <SessionChip status={statusToChip(deriveSessionDisplayStatus(blockedRow, NOW))} />,
    );
    const chip = chipBox.firstElementChild?.textContent;
    cleanup();

    const stage = sessionTurnStage({ live: true, display: deriveSessionDisplayStatus(blockedRow, NOW) });
    const { container: page } = render(
      stage ? <TurnStage stage={stage} waitingOn="Waiting on a person. Approve the database restore in Coolify." /> : <span />,
    );
    const pageLine = page.querySelector("[data-testid=turn-stage]")?.textContent?.split(". ")[0];
    const spinning = page.querySelector("[role=status]") !== null;
    cleanup();

    listed = blockedRow;
    const { container: list } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    const listChip = list.querySelector("tbody span.rounded-md.font-semibold")?.textContent;
    const workingFigure = [...list.querySelectorAll(".fg-overline")].find((el) => el.textContent === WORKING_WORD)
      ?.nextElementSibling?.textContent;
    const workingTab = [...list.querySelectorAll("button")]
      .map((b) => b.textContent ?? "")
      .find((t) => t.startsWith(`${WORKING_WORD} `));
    listed = row;
    cleanup();

    expect(reference).toBe("Blocked");
    expect({ dashboard, chip, pageLine, listChip, spinning }).toEqual({
      dashboard: reference,
      chip: reference,
      pageLine: reference,
      listChip: reference,
      spinning: false,
    });
    expect({ workingFigure, workingTab }).toEqual({ workingFigure: "0", workingTab: `${WORKING_WORD} 0` });
  });

  it("says on its own page what it last reported once it goes quiet", () => {
    const display = deriveSessionDisplayStatus(quietBlockedRow, NOW);
    const stage = sessionTurnStage({ live: true, display });
    const { container: page } = render(
      stage ? <TurnStage stage={stage} silentForMs={NOW - Date.parse(SILENT_SINCE)} reported="Blocked" /> : <span />,
    );
    expect(page.querySelector("[data-testid=turn-stage]")?.textContent).toBe("Quiet. Last reported blocked 1m ago.");
  });
});

describe("the sessions list at a phone's width (ISS-1228 criterion 51)", () => {
  it("lists each session as a flush row under a hairline, not a card", () => {
    listed = row;
    const { container } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    const list = container.querySelector<HTMLElement>("ul[aria-label='Sessions']");
    expect(list?.className).toMatch(/divide-y/);
    const items = [...(list?.querySelectorAll<HTMLElement>(":scope > li") ?? [])];
    expect(items).toHaveLength(1);
    for (const item of items) {
      expect(item.className).not.toMatch(/rounded|(^|\s)border(\s|$)/);
      expect(item.querySelector(".rounded-lg.border, .rounded-xl.border")).toBeNull();
    }
    cleanup();
  });
});

describe("a quiet session read against core's own silence limit (ISS-1228 round 9)", () => {
  const FOUR_MIN_AGO = new Date(NOW - 4 * 60_000).toISOString();
  const ELEVEN_MIN_AGO = new Date(NOW - 11 * 60_000).toISOString();
  const TEN_MIN = 10 * 60_000;
  const blockedReport = {
    incarnation: "live",
    work: "blocked",
    blockerKind: "human",
    waitingOn: "a decision on the schema",
    observedAt: FOUR_MIN_AGO,
    since: FOUR_MIN_AGO,
  };

  it("reads Last reported blocked on the sessions list, as the session page and the Pipeline page do", () => {
    listed = { ...row, lastHeartbeatAt: FOUR_MIN_AGO, updatedAt: FOUR_MIN_AGO, report: blockedReport, silenceLimitMs: TEN_MIN };
    const { container } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    const cell = container.querySelector("tbody")?.textContent ?? "";
    listed = row;
    cleanup();
    expect(cell).toContain(lastReported("Blocked"));
    expect(cell).not.toContain("awaiting auto-recovery");
  });

  it("counts the sessions list's countdown to core's ten minutes for a run session, saying core ends it as failed", () => {
    listed = { ...row, lastHeartbeatAt: FOUR_MIN_AGO, updatedAt: FOUR_MIN_AGO, silenceLimitMs: TEN_MIN };
    const { container } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    const cell = container.querySelector("tbody")?.textContent ?? "";
    listed = row;
    cleanup();
    expect(cell).toContain("Core ends it as failed in 6m 00s.");
    expect(cell).not.toMatch(/recover/i);
  });

  it("says core is ending a run as failed on the runs tab only once core's limit has passed", () => {
    const before = render(
      <ul>
        <RunRow row={{ ...run, lastActivityAt: FOUR_MIN_AGO, silenceLimitMs: TEN_MIN }} now={NOW} slug="pair" />
      </ul>,
    ).container.textContent;
    cleanup();
    const after = render(
      <ul>
        <RunRow row={{ ...run, lastActivityAt: ELEVEN_MIN_AGO, silenceLimitMs: TEN_MIN }} now={NOW} slug="pair" />
      </ul>,
    ).container.textContent;
    cleanup();
    expect(before).not.toContain("Core is ending it as failed.");
    expect(after).toContain("Core is ending it as failed.");
    expect(after).not.toMatch(/recover/i);
  });
});

// ISS-1228 round 10: a running session doing something specific read its activity on the Pipeline page
// and the dashboard and Working on the sessions list, its own page and the runs tab; Waiting for me
// stayed 0 while the Pipeline page said Waiting for input; and a quiet blocked run said "Blocked,
// holding the box" in the present tense on the runs tab.
describe("one word for a session, on every surface (ISS-1228 round 10)", () => {
  const ACTIVITIES: Array<[string, string]> = [
    ["starting", "Starting"],
    ["awaiting_input", "Waiting for input"],
    ["checkpointing", "Checkpointing"],
    ["closed", "Closing"],
  ];

  // The session's own page is read through `SessionScreen` in session-screen-blocked.test.tsx.
  it.each(ACTIVITIES)("calls a heard-from session at %s %s on every surface", (runtimeState, word) => {
    const heardLive = { ...live, runtimeState, lastHeartbeatAt: HEARD_AT };
    const heardRow = { ...row, runtimeState, lastHeartbeatAt: HEARD_AT, updatedAt: HEARD_AT };
    const surfaces: Record<string, string> = {};

    surfaces.pipeline = render(<SessionsList sessions={[heardLive]} slug="pair" now={NOW} />).container.textContent ?? "";
    cleanup();
    surfaces.dashboard =
      render(<LiveSessionsCard sessions={[heardLive]} slug="pair" now={NOW} read={{ read: "ok" }} />).container
        .textContent ?? "";
    cleanup();
    listed = heardRow;
    surfaces.list = render(<SessionsScreen scope={{ projectId: "p1" }} />).container.querySelector("tbody")?.textContent ?? "";
    listed = row;
    cleanup();
    surfaces.runs =
      render(
        <ul>
          <RunRow row={{ ...run, lastActivityAt: HEARD_AT, sessionRuntimeState: runtimeState }} now={NOW} slug="pair" />
        </ul>,
      ).container.textContent ?? "";
    cleanup();

    for (const [surface, text] of Object.entries(surfaces)) {
      expect({ surface, says: text.includes(word) }).toEqual({ surface, says: true });
      expect({ surface, working: text.includes(WORKING_WORD) }).toEqual({ surface, working: false });
    }
  });

  it("counts a session the Pipeline page calls Waiting for input under Waiting for me, and not under Working", () => {
    listed = { ...row, runtimeState: "awaiting_input", lastHeartbeatAt: HEARD_AT, updatedAt: HEARD_AT };
    const { container } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    const text = container.textContent ?? "";
    listed = row;
    cleanup();
    expect(text).toContain("Waiting for me 1");
    expect(text).toContain(`${WORKING_WORD} 0`);
  });

  it("counts under Working only the sessions it calls Working", () => {
    listed = { ...row, runtimeState: "checkpointing", lastHeartbeatAt: HEARD_AT, updatedAt: HEARD_AT };
    const checkpointing = render(<SessionsScreen scope={{ projectId: "p1" }} />).container.textContent ?? "";
    cleanup();
    listed = { ...row, runtimeState: "working", lastHeartbeatAt: HEARD_AT, updatedAt: HEARD_AT };
    const working = render(<SessionsScreen scope={{ projectId: "p1" }} />).container.textContent ?? "";
    listed = row;
    cleanup();
    expect(checkpointing).toContain(`${WORKING_WORD} 0`);
    expect(working).toContain(`${WORKING_WORD} 1`);
  });

  it("counts a running chat under Working, as its chip says Working", () => {
    listed = {
      ...row,
      kind: "chat",
      metadata: { type: "chat" },
      lastHeartbeatAt: HEARD_AT,
      updatedAt: HEARD_AT,
    } as SessionRow;
    const { container } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    const text = container.textContent ?? "";
    listed = row;
    cleanup();
    expect(text).toContain(`${WORKING_WORD} 1`);
  });

  it("says a quiet blocked run last reported blocked on the runs tab, never that it is blocked now", () => {
    const quietBlocked = {
      ...run,
      work: "blocked",
      blockerKind: "human",
      waitingOn: "approve the restore",
      lastActivityAt: SILENT_SINCE,
    };
    for (const sessionStatus of ["running", "failed"]) {
      const text =
        render(
          <ul>
            <RunRow row={{ ...quietBlocked, sessionStatus }} now={NOW} slug="pair" />
          </ul>,
        ).container.textContent ?? "";
      cleanup();
      expect(text).toContain(lastReported("Blocked"));
      expect(text).not.toContain("Blocked, holding the box");
    }
  });
});

// ISS-1228 round 10: on the sessions list "Waiting for input" and "Checkpointing" wore the Working
// sparkle, because a chip's mark followed its status and every activity is the running status.
describe("every word a session chip shows has a mark of its own (ISS-1228 criterion 65)", () => {
  const heard = { ...row, lastHeartbeatAt: HEARD_AT, updatedAt: HEARD_AT };
  const shown: Array<{ session: SessionRow; status?: StatusKey }> = [
    { session: { ...heard, runtimeState: "working" } },
    { session: { ...heard, runtimeState: "awaiting_input" } },
    { session: { ...heard, runtimeState: "starting" } },
    { session: { ...heard, runtimeState: "checkpointing" } },
    { session: { ...heard, runtimeState: "closed" } },
    {
      session: {
        ...heard,
        report: {
          incarnation: "live",
          work: "blocked",
          blockerKind: "human",
          waitingOn: "a decision",
          observedAt: HEARD_AT,
          since: HEARD_AT,
        },
      },
    },
    { session: { ...heard, status: "queued" } },
    { session: { ...heard, status: "idle" } },
    { session: row },
    { session: { ...row, status: "completed" } },
    { session: { ...row, status: "failed", failureReason: "crashed" } },
    { session: { ...row, status: "cancelled" } },
    { session: { ...row, status: "cancelled_stale" } },
    { session: { ...heard, kind: "chat", metadata: { type: "chat" }, status: "idle" } },
    { session: { ...heard, kind: "chat", metadata: { type: "chat" } }, status: "waiting" },
  ];

  function chipOf({ session, status }: { session: SessionRow; status?: StatusKey }): [string, string] {
    const { container } = render(
      <SessionChip status={status ?? statusToChip(deriveSessionDisplayStatus(session, NOW))} session={session} now={NOW} />,
    );
    const svg = container.querySelector("svg");
    const mark = svg ? [...svg.children].map((c) => c.outerHTML).join("") : "";
    const word = container.textContent ?? "";
    cleanup();
    return [word, mark];
  }

  it("draws a different mark for every word, Waiting for input sharing only the bell of Waiting for me", () => {
    const chips = shown.map(chipOf);
    const words = chips.map(([word]) => word);
    expect(new Set(words).size, words.join(" | ")).toBe(chips.length);
    const byMark = new Map<string, string[]>();
    for (const [word, mark] of chips) byMark.set(mark, [...(byMark.get(mark) ?? []), word]);
    const shared = [...byMark.values()].filter((w) => w.length > 1).map((w) => w.sort());
    expect(shared).toEqual([["Waiting for input", "Waiting for me"]]);
    expect(chips.every(([, mark]) => mark !== "")).toBe(true);
  });

  it("pulses only the Working word's mark", () => {
    for (const runtimeState of ["awaiting_input", "starting", "checkpointing", "closed"]) {
      const { container } = render(
        <SessionChip status="running" session={{ ...heard, runtimeState }} now={NOW} />,
      );
      expect(container.querySelector("svg")?.getAttribute("class") ?? "").not.toMatch(/forge-pulse/);
      cleanup();
    }
  });
});


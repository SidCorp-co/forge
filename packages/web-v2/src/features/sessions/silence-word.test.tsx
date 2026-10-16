// @vitest-environment jsdom
//
// One running session, in each of its two states. Silent ninety seconds, every surface that shows it
// names that silence with the Pipeline page's word, in the Pipeline page's tone, and none of them
// claims it is working. Checking in, every surface calls it Working. A surface with its own word for
// either state goes red here.

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastReported, WORKING_WORD } from "@/design";
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
vi.mock("@/features/runners/hooks", () => ({ useDevices: () => ({ data: [] }) }));
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
    word: (el.textContent ?? "").split(" · ")[0].trim(),
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
        <RunRow row={run} now={NOW} />
      </ul>,
    );
    const agentsRuns = readingOf(spans(runs).find((el) => /no report for/.test(el.textContent ?? "") && el.children.length === 0));
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
        <RunRow row={run} now={NOW} />
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
    expect(pageLine?.textContent).toBe("Quiet · last reported working 1m ago");
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
        <RunRow row={beatingRun} now={NOW} />
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

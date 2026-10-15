// @vitest-environment jsdom
//
// One running session, silent ninety seconds: every surface that shows it names that silence with
// the Pipeline page's word, in the Pipeline page's tone, so a surface with its own goes red here.

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusChip } from "@/design";
import { RunRow } from "@/features/agents/components/run-row";
import type { RunSessionRow } from "@/features/agents/types";
import { SessionsList } from "@/features/pipeline/components/sessions-list";
import type { LiveSession } from "@/features/pipeline/types";
import { LiveSessionsCard } from "@/features/project-dashboard/components/live-sessions-card";
import { FleetStrip } from "./components/fleet-strip";
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
  useSessions: () => ({ data: { items: [row], totalCount: 1 }, isLoading: false, isError: false }),
  useCancelSession: mutation,
  useRetrySession: mutation,
  useRerunSession: mutation,
  useAbortSession: mutation,
  useSweepZombies: mutation,
}));

const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const SILENT_SINCE = new Date(NOW - 90_000).toISOString();
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
  work: "working",
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
      <StatusChip status={statusToChip(deriveSessionDisplayStatus(row, NOW))} domain="session" />,
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

    const { container: list } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    // The list's summary counts the silent session under the state's word, its figure in the state's ink.
    const stat = [...list.querySelectorAll(".fg-overline")].find(
      (el) => el.nextElementSibling?.textContent === "1" && el.textContent !== "Active",
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
});

// @vitest-environment jsdom
//
// ISS-1228 round 10 — the dashboard said "0 of 0 runners busy" while the sessions page's box strip
// said "Busy · 1/1" for the same box: the strip read the project's device pool and the sessions list,
// the dashboard the project's runners, the queue, the active runners and the live sessions, and only
// the dashboard left an offline box out. Both now read one summary; a box that is offline is called
// offline on both, and busy is said only of a box that is online.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetStrip } from "@/features/sessions/components/fleet-strip";
import type { AgentSessionDisplayStatus, SessionRow } from "@/features/sessions/types";
import { StatStrip, type StatStripProps } from "./components/stat-strip";
import { useRunnerFleet } from "./runner-fleet";

const NOW = Date.parse("2026-10-16T10:00:00.000Z");
const HEARD = new Date(NOW - 5_000).toISOString();

const { world } = vi.hoisted(() => ({
  world: {
    runners: [] as Array<Record<string, unknown>>,
    live: [] as Array<{ id: string; deviceId: string | null }>,
    queued: [] as Array<{ deviceId: string; queued: number; running: number }>,
    queueFails: false,
    activeFails: false,
  },
}));

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({
    data: {
      defaultDeviceId: "d1",
      devicePool: world.runners.map((r) => ({
        id: r.deviceId,
        name: r.deviceName,
        platform: "linux",
        status: r.deviceStatus,
      })),
    },
  }),
}));
vi.mock("@/features/runners/hooks", () => ({
  useProjectRunners: () => ({ data: world.runners, isError: false, error: null }),
  useActiveRunners: () =>
    world.activeFails
      ? { data: undefined, isError: true, error: new Error("active runners down") }
      : { data: { runners: [], busy: 0 }, isError: false, error: null },
}));
vi.mock("@/features/sessions/hooks", () => ({
  useQueueStats: () =>
    world.queueFails
      ? { data: undefined, isError: true, error: new Error("queue down") }
      : { data: { devices: world.queued }, isError: false, error: null },
}));
vi.mock("@/features/pipeline/hooks", () => ({
  useSessionsAndHolds: () => ({
    data: { sessions: world.live, holds: [], readAt: HEARD },
    isError: false,
    error: null,
  }),
}));

afterEach(() => {
  cleanup();
  world.queued = [];
  world.queueFails = false;
  world.activeFails = false;
});

function runner(deviceId: string, deviceStatus: "online" | "offline") {
  return {
    runnerId: `r-${deviceId}`,
    deviceId,
    deviceName: `box-${deviceId}`,
    platform: "linux",
    deviceStatus,
    runnerStatus: "online",
    limitReason: null,
    rateLimitedUntil: null,
    limitDetail: null,
  };
}

function liveRow(deviceId: string): SessionRow {
  return {
    id: `s-${deviceId}`,
    projectId: "p1",
    deviceId,
    status: "running",
    kind: "run_session",
    title: "run: grp-1",
    metadata: { type: "run_session" },
    startedAt: HEARD,
    lastHeartbeatAt: HEARD,
    createdAt: HEARD,
    updatedAt: HEARD,
  } as unknown as SessionRow;
}

const FIGURES: Omit<StatStripProps, "busyRunners" | "onlineRunners" | "totalRunners"> = {
  liveSessions: 1,
  needsYou: 0,
  needsYouCaption: "",
  oldestWait: null,
  openWork: 0,
  openWorkMadeOf: "",
  spendTodayUsd: 0,
  spendComparison: null,
  inFlightUsd: 0,
};

/** The dashboard's runner figure, read the way the dashboard page reads it. */
function DashboardFigure() {
  const fleet = useRunnerFleet("p1", NOW);
  return (
    <StatStrip
      {...FIGURES}
      busyRunners={fleet.summary.busyCount}
      onlineRunners={fleet.summary.onlineCount}
      totalRunners={fleet.summary.total}
    />
  );
}

/** What each surface says about the runners: the dashboard's caption, and the strip's word per box. */
function readBoth(rows: SessionRow[]): { caption: string; boxes: string[] } {
  const displays = rows.map((): AgentSessionDisplayStatus => "running");
  render(<DashboardFigure />);
  const caption = screen.getByText(/runner/).textContent ?? "";
  cleanup();
  render(<FleetStrip projectId="p1" rows={rows} displays={displays} now={NOW} />);
  const boxes = screen.queryAllByTestId("box-word").map((b) => b.textContent ?? "");
  cleanup();
  return { caption, boxes };
}

describe("the dashboard and the box strip read one runner summary (ISS-1228 criterion 66)", () => {
  it("calls an online box hosting a live session busy on both", () => {
    world.runners = [runner("d1", "online")];
    world.live = [{ id: "s-d1", deviceId: "d1" }];
    expect(readBoth([liveRow("d1")])).toEqual({ caption: "1 of 1 runners busy", boxes: ["Busy · 1 live session"] });
  });

  it("calls an offline box offline on both, though a session on it is still live, and busy on neither", () => {
    world.runners = [runner("d1", "offline")];
    world.live = [{ id: "s-d1", deviceId: "d1" }];
    expect(readBoth([liveRow("d1")])).toEqual({
      caption: "1 runner · none online",
      boxes: ["Offline · 1 live session"],
    });
  });

  it("counts every box the strip lists, the offline ones named apart", () => {
    world.runners = [runner("d1", "online"), runner("d2", "offline")];
    world.live = [];
    expect(readBoth([])).toEqual({
      caption: "0 of 1 runners busy · 1 offline",
      boxes: ["Free", "Offline"],
    });
  });
});

// The strip read its queue from the summary, which drops the queue unless every activity read is in.
describe("the box strip's queue", () => {
  function queueWord(): string {
    render(<FleetStrip projectId="p1" rows={[]} displays={[]} now={NOW} />);
    const word = screen.getByTestId("box-queue").textContent ?? "";
    cleanup();
    return word;
  }

  it("keeps the queue it read when another read is out", () => {
    world.runners = [runner("d1", "online")];
    world.live = [];
    world.queued = [{ deviceId: "d1", queued: 3, running: 0 }];
    world.activeFails = true;
    expect(queueWord()).toBe("3 queued");
  });

  it("says the queue was not read, never that there is none, when its read failed", () => {
    world.runners = [runner("d1", "online")];
    world.live = [];
    world.queueFails = true;
    expect(queueWord()).toBe("queue not read");
  });
});

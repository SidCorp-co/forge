// @vitest-environment jsdom
//
// ISS-1228 round 14 — the master read box-a as "Spare" beside "Busy · 3 live sessions": a box read two
// ways at once. A box not pinned as the default has no role worth a word; its state says the rest.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../types";

expect.extend(matchers);

const BOXES = [
  { id: "dev-a", name: "box-a", platform: "linux", status: "online" },
  { id: "dev-b", name: "box-b", platform: "linux", status: "offline" },
];
const runner = (deviceId: string, name: string, online: boolean) => ({
  runnerId: `r-${deviceId}`,
  deviceId,
  deviceName: name,
  platform: "linux",
  deviceStatus: online ? "online" : "offline",
  runnerStatus: online ? "online" : "offline",
  limitReason: null,
});

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { devicePool: BOXES, defaultDeviceId: "dev-a" } }),
}));
vi.mock("../hooks", () => ({
  useQueueStats: () => ({ data: { devices: [] }, isError: false, error: null }),
}));
vi.mock("@/features/runners/hooks", () => ({
  useDevices: () => ({ data: [] }),
  useProjectRunners: () => ({
    data: [runner("dev-a", "box-a", true), runner("dev-b", "box-b", false)],
    isError: false,
    error: null,
  }),
  useActiveRunners: () => ({ data: { runners: [], busy: 0 }, isError: false, error: null }),
}));
vi.mock("@/features/pipeline/hooks", () => ({
  useSessionsAndHolds: () => ({
    data: {
      sessions: [
        { id: "s-a1", deviceId: "dev-a" },
        { id: "s-a2", deviceId: "dev-a" },
        { id: "s-b1", deviceId: "dev-b" },
      ],
      holds: [],
      readAt: "",
    },
    isError: false,
    error: null,
  }),
}));

afterEach(cleanup);

const session = {
  id: "s-a1",
  projectId: "p1",
  deviceId: "dev-a",
  status: "running",
  metadata: {},
} as unknown as SessionRow;

async function boxRow(name: string): Promise<HTMLElement> {
  const { FleetStrip } = await import("./fleet-strip");
  render(<FleetStrip projectId="p1" rows={[session]} displays={["running"]} now={Date.now()} />);
  const list = screen.getByRole("list", { name: "Boxes" });
  return within(list).getByText(name).closest("li") as HTMLElement;
}

describe("a box on the sessions page reads one way", () => {
  it("names the default box Primary beside its live state", async () => {
    const row = await boxRow("box-a");
    expect(within(row).getByText("Primary")).toBeInTheDocument();
    expect(within(row).getByTestId("box-word")).toHaveTextContent("Busy · 2 live sessions");
  });

  it("calls no box Spare, whether it is working or offline", async () => {
    const row = await boxRow("box-b");
    expect(within(row).getByTestId("box-word")).toHaveTextContent("Offline · 1 live session");
    expect(screen.queryByText(/spare/i)).toBeNull();
  });
});

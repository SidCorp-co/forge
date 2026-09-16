// @vitest-environment jsdom
//
// The busy device's detail row, ISS-999.
//
// Until this change the step shown here came from `deriveStage`, which always answered SOMETHING —
// `code` for anything it did not recognise — so the row could never be empty. It shows the step the
// session recorded now, and a session may have recorded none, which makes every part of this row
// optional for the first time.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../types";

expect.extend(matchers);

const DEVICE = { id: "dev-1", name: "forge-vm", platform: "linux", status: "online" };

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { devicePool: [DEVICE], defaultDeviceId: "dev-1" } }),
}));
vi.mock("../hooks", () => ({
  useQueueStats: () => ({ data: { perDevice: [] } }),
}));

afterEach(cleanup);

const NOW = Date.parse("2026-09-14T00:00:00.000Z");

function row(over: Partial<SessionRow> & { metadata?: Record<string, unknown> }): SessionRow {
  return {
    id: "s-1",
    projectId: "p1",
    deviceId: "dev-1",
    status: "running",
    title: null,
    startedAt: "2026-09-14T00:00:00.000Z",
    lastHeartbeatAt: "2026-09-14T00:00:00.000Z",
    ...over,
  } as unknown as SessionRow;
}

async function renderStrip(session: SessionRow) {
  const { FleetStrip } = await import("./fleet-strip");
  render(
    <FleetStrip projectId="p1" rows={[session]} displays={["running"]} now={NOW} />,
  );
}

describe("the busy device's detail row (ISS-999)", () => {
  it("names the step the session recorded", async () => {
    await renderStrip(row({ metadata: { type: "pipeline", step: "drive" }, title: "ISS-42 a title" }));
    expect(screen.getByText("drive")).toBeInTheDocument();
    expect(screen.getByText("ISS-42")).toBeInTheDocument();
  });

  it("renders no separator in front of the issue reference when no step was recorded", async () => {
    await renderStrip(row({ metadata: { type: "pipeline" }, title: "ISS-42 a title" }));
    expect(screen.getByText("ISS-42")).toBeInTheDocument();
    expect(screen.queryByText("·")).toBeNull();
  });

  it("renders no detail row at all when there is neither a step nor an issue", async () => {
    await renderStrip(row({ metadata: { type: "pipeline" }, title: null }));
    expect(screen.getByText("Busy · 1/1")).toBeInTheDocument();
    expect(screen.queryByText("·")).toBeNull();
    expect(screen.queryByText("stalled")).toBeNull();
  });
});

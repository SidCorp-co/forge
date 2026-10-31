// @direct-test-of packages/web-v2/src/features/sessions/components/fleet-strip.tsx
// The strip renders core's queue read model: the stalled banner and its count come from
// `/agent-sessions/queue-stats` (REQ-12 BC-19), never from the rows or the pool it is handed.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const queue = { data: undefined as unknown };
vi.mock("@/features/projects", () => ({ useProject: () => ({ isSuccess: true, isError: false, data: { devicePool: [{ id: "d1", name: "box", platform: "linux", status: "online" }] } }) }));
vi.mock("../hooks", () => ({ useQueueStats: () => queue }));

import { FleetStrip } from "./fleet-strip";

const props = { projectId: "p", rows: [], displays: [], now: 0, stuck: { runs: [] } as never };
afterEach(cleanup);

describe("the fleet strip", () => {
  it("shows the stalled banner core serves, with core's waiting count", () => {
    queue.data = { devices: [], waiting: 3, onlineRunners: 0, dispatchStalled: true };
    render(<FleetStrip {...props} />);
    expect(screen.getByText(/Dispatch stalled/)).toBeTruthy();
    expect(document.body.textContent).toContain("3 sessions queued with no runner");
  });

  it("shows no banner when core says dispatch is not stalled, whatever the pool holds", () => {
    queue.data = { devices: [], waiting: 3, onlineRunners: 1, dispatchStalled: false };
    render(<FleetStrip {...props} />);
    expect(screen.queryByText(/Dispatch stalled/)).toBeNull();
  });
});

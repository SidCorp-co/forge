// @vitest-environment jsdom
//
// ISS-1228 round 12: judge-31 saw run r6 read "On ISS-2 ISS-3" on the sessions list after core had
// let ISS-2 go, and nothing there said core still held ISS-3 though r6's box called it returned. The
// list names what core holds, as core sends it, and says the disagreement in the runs tab's words.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../types";
import { SessionsScreen } from "./sessions-screen";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/projects/pair/agents" }));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { devicePool: [], defaultDeviceId: null } }),
  useProjects: () => ({ data: [{ id: "p1", slug: "pair", name: "Pair", role: "owner" }] }),
  useOrgScopedProjects: () => ({ projects: [], projectIds: new Set(["p1"]) }),
}));
vi.mock("@/features/runners/hooks", () => ({
  useDevices: () => ({ data: [] }),
  useProjectRunners: () => ({ data: [], isError: false, error: null }),
  useActiveRunners: () => ({ data: { runners: [], busy: 0 }, isError: false, error: null }),
}));
vi.mock("@/features/pipeline/hooks", () => ({
  useSessionsAndHolds: () => ({ data: { sessions: [], holds: [], readAt: "" }, isError: false, error: null }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
const { mutation } = vi.hoisted(() => ({ mutation: () => ({ mutate: () => {}, isPending: false }) }));
vi.mock("../hooks", () => ({
  useQueueStats: () => ({ data: { devices: [] } }),
  useSessions: () => ({ data: { items: rows, totalCount: rows.length }, isLoading: false, isError: false }),
  useCancelSession: mutation,
  useRetrySession: mutation,
  useRerunSession: mutation,
  useAbortSession: mutation,
  useSweepZombies: mutation,
}));

const AT = new Date().toISOString();

function run(id: string, issues: SessionRow["issues"]): SessionRow {
  return {
    id,
    projectId: "p1",
    userId: null,
    deviceId: null,
    pipelineRunId: "r1",
    title: `run: ${id}`,
    repoPath: null,
    status: "running",
    kind: "run_session",
    usage: null,
    metadata: { type: "run_session" },
    failureReason: null,
    dispatchedAt: null,
    startedAt: AT,
    lastHeartbeatAt: AT,
    createdAt: AT,
    updatedAt: AT,
    issues,
  } as SessionRow;
}

let rows: SessionRow[] = [];

const SENTENCE = "The box says it returned ISS-3. Core still holds it. Stop the session to free it.";

describe("the sessions list and a lease the box returned (ISS-1228 round 12)", () => {
  it("names the issue core still holds and says its box returned it", () => {
    rows = [run("r6", [{ id: "i3", displayId: "ISS-3", title: "Three", boxReturned: true }])];
    render(<SessionsScreen scope={{ projectId: "p1" }} />);
    const sentences = screen.getAllByText(SENTENCE);
    expect(sentences.length).toBeGreaterThan(0);
    for (const s of sentences) {
      const cell = s.parentElement as HTMLElement;
      expect(within(cell).getAllByText("ISS-3").length).toBeGreaterThan(0);
    }
    expect(screen.queryByText("ISS-2")).toBeNull();
  });

  it("says nothing of a disagreement where the box and core agree", () => {
    rows = [run("r7", [{ id: "i3", displayId: "ISS-3", title: "Three", boxReturned: false }])];
    const { container } = render(<SessionsScreen scope={{ projectId: "p1" }} />);
    expect(container.textContent).not.toMatch(/The box says it returned/);
  });
});

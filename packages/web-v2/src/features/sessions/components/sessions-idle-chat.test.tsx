// @vitest-environment jsdom
//
// ISS-1228 round 16 (judge-42): a chat whose turn had ended read "Waiting for me" on its row, was
// counted under Queued with a median wait of ten minutes and was listed by the Queued filter, though
// nothing waits on a box for it; and a chat's row drew no box dot where a run's row drew one.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
const { mutation, stopSession } = vi.hoisted(() => ({
  mutation: () => ({ mutate: () => {}, isPending: false }),
  stopSession: vi.fn(),
}));
vi.mock("../hooks", () => ({
  useQueueStats: () => ({ data: { devices: [] } }),
  useSessions: () => ({ data: { items: rows, totalCount: rows.length }, isLoading: false, isError: false }),
  useCancelSession: () => ({ mutate: stopSession, isPending: false }),
  useRetrySession: mutation,
  useRerunSession: mutation,
  useAbortSession: mutation,
  useSweepZombies: mutation,
}));

const AT = new Date(Date.now() - 10 * 60_000).toISOString();

function session(id: string, over: Partial<SessionRow>): SessionRow {
  return {
    id,
    projectId: "p1",
    userId: null,
    deviceId: "d1",
    pipelineRunId: null,
    title: id,
    repoPath: null,
    status: "running",
    kind: "chat",
    usage: null,
    metadata: { type: "chat" },
    failureReason: null,
    dispatchedAt: AT,
    startedAt: AT,
    lastHeartbeatAt: new Date().toISOString(),
    createdAt: AT,
    updatedAt: AT,
    boxOnline: true,
    issues: [],
    ...over,
  } as SessionRow;
}

let rows: SessionRow[] = [];

const idleChat = session("chat-idle", { status: "idle" });
const runningChat = session("chat-running", {});
const run = session("run-one", { kind: "run_session", metadata: { type: "run_session" }, pipelineRunId: "r1" });
const queuedRun = session("run-queued", {
  kind: "run_session",
  metadata: { type: "run_session" },
  status: "queued",
  startedAt: null,
  lastHeartbeatAt: null,
});

const pill = (label: string): HTMLElement => {
  const name = screen.getAllByText(label).find((el) => el.className.includes("fg-overline"));
  if (!name?.parentElement) throw new Error(`no ${label} figure`);
  return name.parentElement;
};

const rowOf = (id: string): HTMLElement => {
  const tag = screen.getAllByText(id.slice(0, 8))[0];
  const row = tag?.closest("tr");
  if (!row) throw new Error(`no row for ${id}`);
  return row as HTMLElement;
};

describe("an idle chat on the sessions list (ISS-1228 round 16)", () => {
  it("is not counted under Queued, nor in the median wait", () => {
    rows = [idleChat, run];
    render(<SessionsScreen scope={{ projectId: "p1" }} />);
    expect(pill("Queued")).toHaveTextContent(/^Queued0$/);
    expect(pill("Median wait")).toHaveTextContent(/^Median wait—$/);
  });

  it("counts a session waiting on a box under Queued, beside an idle chat", () => {
    rows = [idleChat, queuedRun];
    render(<SessionsScreen scope={{ projectId: "p1" }} />);
    expect(pill("Queued")).toHaveTextContent(/^Queued1$/);
  });

  it("is not listed by the Queued filter, which counts what it lists", () => {
    rows = [idleChat, queuedRun, run];
    render(<SessionsScreen scope={{ projectId: "p1" }} />);
    const tab = screen.getByRole("button", { name: /^Queued \d+$/ });
    expect(tab).toHaveTextContent("Queued 1");
    fireEvent.click(tab);
    expect(screen.queryAllByText("chat-idl")).toHaveLength(0);
    expect(screen.getAllByText("run-queu").length).toBeGreaterThan(0);
  });

  it("reads Waiting for me on its row", () => {
    rows = [idleChat];
    render(<SessionsScreen scope={{ projectId: "p1" }} />);
    expect(within(rowOf("chat-idle")).getByText("Waiting for me")).toBeInTheDocument();
  });
});

describe("the box dot on the sessions list (ISS-1228 round 16)", () => {
  it("is drawn on every session core has not ended that names a box, a chat's included", () => {
    rows = [idleChat, runningChat, run];
    render(<SessionsScreen scope={{ projectId: "p1" }} />);
    for (const s of rows) {
      expect(within(rowOf(s.id)).getByTestId("box-dot"), s.id).toHaveAttribute("data-health", "healthy");
    }
  });

  it("reads the box offline on a chat as on a run", () => {
    rows = [session("chat-off", { boxOnline: false, status: "idle" }), { ...run, id: "run-off", boxOnline: false }];
    render(<SessionsScreen scope={{ projectId: "p1" }} />);
    for (const s of rows) {
      expect(within(rowOf(s.id)).getByTestId("box-dot"), s.id).toHaveAttribute("data-health", "attention");
    }
  });

  it("is not drawn on a session core has ended", () => {
    rows = [session("chat-done", { status: "completed" })];
    render(<SessionsScreen scope={{ projectId: "p1" }} />);
    expect(within(rowOf("chat-done")).queryByTestId("box-dot")).toBeNull();
  });
});

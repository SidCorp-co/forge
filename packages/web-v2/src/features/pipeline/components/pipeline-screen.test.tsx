// @vitest-environment jsdom
//
// ISS-1228 — the Pipeline page reads sessions and holds: one row per live session and per held
// issue, each linking where it names, a sentence where a list is empty, placeholders while reading,
// a refusal with Retry when the read fails, and the last reading kept when a refresh fails.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsAndHolds } from "../types";
import { PipelineScreen } from "./pipeline-screen";

expect.extend(matchers);
afterEach(cleanup);

interface QueryState {
  data?: SessionsAndHolds;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}
let query: QueryState;

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/design/hooks/use-now", () => ({ useNow: () => Date.parse("2026-10-15T02:00:00.000Z") }));
vi.mock("../hooks", () => ({ useSessionsAndHolds: () => query }));

const reading: SessionsAndHolds = {
  readAt: "2026-10-15T01:59:50.000Z",
  sessions: [
    {
      id: "m1",
      kind: "master",
      title: "master: forge-master-forge-dev",
      status: "running",
      runtimeState: "working",
      deviceId: "d1",
      deviceName: "box-a",
      parentSessionId: null,
      startedAt: "2026-10-15T00:00:00.000Z",
      lastHeartbeatAt: "2026-10-15T01:59:50.000Z",
      createdAt: "2026-10-15T00:00:00.000Z",
      issues: [],
      report: null,
    },
    {
      id: "s1",
      kind: "run_session",
      title: "run: ISS-7",
      status: "running",
      runtimeState: "awaiting_input",
      deviceId: "d1",
      deviceName: "box-a",
      parentSessionId: "m1",
      startedAt: "2026-10-15T01:00:00.000Z",
      lastHeartbeatAt: "2026-10-15T01:55:00.000Z",
      createdAt: "2026-10-15T01:00:00.000Z",
      issues: [{ issueId: "i7", displayId: "ISS-7", title: "Seven" }],
      report: {
        incarnation: "live",
        work: "blocked",
        blockerKind: "human",
        waitingOn: "an answer on ISS-7",
        observedAt: "2026-10-15T01:59:00.000Z",
      },
    },
  ],
  holds: [
    {
      issueId: "i7",
      displayId: "ISS-7",
      title: "Seven",
      status: "in_progress",
      holders: [
        {
          by: "session",
          sessionId: "s1",
          sessionTitle: "run: ISS-7",
          sessionKind: "run_session",
          deviceName: "box-a",
          since: "2026-10-15T01:00:05.000Z",
        },
      ],
    },
    {
      issueId: "i9",
      displayId: "ISS-9",
      title: "Nine",
      status: "needs_info",
      holders: [{ by: "person", status: "needs_info", owes: "decision", since: "2026-10-15T01:30:00.000Z", why: "which reading ships" }],
    },
  ],
};

beforeEach(() => {
  query = { data: reading, isError: false, error: null, refetch: vi.fn() };
});

const screenFor = () => render(<PipelineScreen scope={{ projectId: "p1", slug: "forge-dev" }} />);

describe("the Pipeline page with a reading", () => {
  it("lists every live session, the master's own session beneath it, each linking to its page", () => {
    screenFor();
    const rows = within(screen.getByRole("list", { name: "Live sessions" })).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-session-id"))).toEqual(["m1", "s1"]);
    expect(within(rows[1] as HTMLElement).getByRole("link", { name: /run: ISS-7/ })).toHaveAttribute(
      "href",
      "/projects/forge-dev/agents/s1",
    );
  });

  it("names the issue a session holds as a link, what it is doing, what it waits on and its quiet check-in", () => {
    screenFor();
    const row = screen.getAllByRole("listitem").find((r) => r.getAttribute("data-session-id") === "s1") as HTMLElement;
    expect(within(row).getByRole("link", { name: /^ISS-7/ })).toHaveAttribute("href", "/projects/forge-dev/issues/i7");
    expect(within(row).getByText("Waiting for input")).toBeInTheDocument();
    expect(within(row).getByText("A person — an answer on ISS-7")).toBeInTheDocument();
    expect(within(row).getByText("Quiet · 5m ago")).toBeInTheDocument();
  });

  it("says a session the box never reported on is unreported, not that nothing blocks it", () => {
    screenFor();
    const row = screen.getAllByRole("listitem").find((r) => r.getAttribute("data-session-id") === "m1") as HTMLElement;
    expect(within(row).getByText("Not reported by the box")).toBeInTheDocument();
    expect(within(row).queryByText("Nothing")).not.toBeInTheDocument();
  });

  it("keeps every field label for a screen reader at desktop width, where the header row is hidden", () => {
    screenFor();
    for (const name of ["On", "Doing", "Waiting on", "Last check-in", "Held by", "Why", "Since"]) {
      for (const label of screen.getAllByText(name, { selector: "span" })) {
        expect(label.className).not.toMatch(/\bsm:hidden\b/);
      }
    }
  });

  it("lists every held issue, a person's first, with who holds it, why and since when", () => {
    screenFor();
    const rows = within(screen.getByRole("list", { name: "Held" }))
      .getAllByRole("listitem")
      .filter((r) => r.hasAttribute("data-issue-id"));
    expect(rows.map((r) => r.getAttribute("data-issue-id"))).toEqual(["i9", "i7"]);
    expect(within(rows[0] as HTMLElement).getByText("A person owes a decision")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("which reading ships")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("30m ago")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("run: ISS-7 on box-a")).toBeInTheDocument();
  });

  it("names no stage, no pipeline run and no job anywhere, and offers no run control", () => {
    const { container } = screenFor();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\b(triage|clarify|plan|code|review|test|release) stage\b/i);
    expect(text).not.toMatch(/\bpipeline run\b|\bjob\b|\bstage\b/i);
    expect(screen.queryByRole("button", { name: /pause|resume|stop|cancel/i })).toBeNull();
  });
});

describe("the Pipeline page with nothing to show, or no reading", () => {
  it("says so in a sentence for each empty list", () => {
    query = { ...query, data: { ...reading, sessions: [], holds: [] } };
    screenFor();
    expect(screen.getByText("No session is live on this project.")).toBeInTheDocument();
    expect(screen.getByText("Nothing on this project is held.")).toBeInTheDocument();
  });

  it("shows placeholder rows while the first read is in flight", () => {
    query = { ...query, data: undefined };
    const { container } = screenFor();
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(2);
  });

  it("says the read failed and offers Retry when nothing was read", () => {
    const refetch = vi.fn();
    query = { data: undefined, isError: true, error: new Error("core is down"), refetch };
    screenFor();
    expect(screen.getByText("Couldn't read sessions and holds")).toBeInTheDocument();
    screen.getByRole("button", { name: /retry/i }).click();
    expect(refetch).toHaveBeenCalled();
  });

  it("keeps the last reading when a refresh fails, and says when it was read", () => {
    query = { ...query, isError: true, error: new Error("blip") };
    screenFor();
    expect(screen.getByRole("status")).toHaveTextContent(/^Could not refresh — showing what was read at \d\d:\d\d\.$/);
    expect(screen.getByRole("list", { name: "Live sessions" })).toBeInTheDocument();
  });
});

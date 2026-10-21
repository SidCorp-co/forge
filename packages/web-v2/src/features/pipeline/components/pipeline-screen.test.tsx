// @vitest-environment jsdom
//
// ISS-1228 — the Pipeline page reads sessions and holds: one row per live session and per held
// issue, each linking where it names, a sentence where a list is empty, placeholders while reading,
// a refusal with Retry when the read fails, and the last reading kept when a refresh fails.

import { markUnreachable } from "@/lib/api/transport-failure";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import type { Holder, SessionsAndHolds } from "../types";
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
  runningChats: [],
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
      issues: [{ issueId: "i7", displayId: "ISS-7", title: "Seven", boxReturned: false }],
      report: {
        incarnation: "live",
        work: "blocked",
        blockerKind: "human",
        waitingOn: "an answer on ISS-7",
        observedAt: "2026-10-15T01:59:00.000Z",
        since: "2026-10-15T01:59:00.000Z",
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
          boxReturned: false,
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

  it("names the issue a session holds as a link, what it last reported, what it waits on and its quiet check-in", () => {
    screenFor();
    const row = screen.getAllByRole("listitem").find((r) => r.getAttribute("data-session-id") === "s1") as HTMLElement;
    expect(within(row).getByRole("link", { name: /^ISS-7/ })).toHaveAttribute("href", "/projects/forge-dev/issues/i7");
    // Its box reports it blocked and it has been silent five minutes, so its row says what it last
    // reported rather than that it is blocked, or working, now.
    expect(within(row).getByText("Last reported blocked")).toBeInTheDocument();
    expect(within(row).queryByText(/^(Blocked|Working|Waiting for input)$/)).not.toBeInTheDocument();
    expect(within(row).getByText("Waiting on a person. An answer on ISS-7.")).toBeInTheDocument();
    expect(within(row).getByText("Quiet · 5m ago")).toBeInTheDocument();
  });

  it("says a master has no wait report of its own, not that nothing blocks it", () => {
    screenFor();
    const row = screen.getAllByRole("listitem").find((r) => r.getAttribute("data-session-id") === "m1") as HTMLElement;
    expect(within(row).getByText("A box reports runs, not masters.")).toBeInTheDocument();
    expect(within(row).queryByText("Nothing")).not.toBeInTheDocument();
  });

  it("keeps every field label for a screen reader at desktop width, where the header row is hidden", () => {
    screenFor();
    for (const name of ["On", "Doing", "Wait", "Last check-in", "Held by", "Why", "Since"]) {
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

  // ISS-1228 round 12: core still held ISS-3 while r6's box called it returned, and the page said
  // nothing of it. The session's row and the Held row both say it, in the sentences every surface uses.
  it("names, on the session's row and its Held row, a lease the box returned and core still holds", () => {
    const [master, run] = reading.sessions as [SessionsAndHolds["sessions"][number], SessionsAndHolds["sessions"][number]];
    const [hold, person] = reading.holds as [SessionsAndHolds["holds"][number], SessionsAndHolds["holds"][number]];
    const sentence = "The box says it returned ISS-7. Core still holds it. Stop the session to free it.";
    query = {
      ...query,
      data: {
        ...reading,
        sessions: [master, { ...run, issues: [{ issueId: "i7", displayId: "ISS-7", title: "Seven", boxReturned: true }] }],
        holds: [
          { ...hold, holders: [{ ...(hold.holders[0] as Extract<Holder, { by: "session" }>), boxReturned: true }] },
          person,
        ],
      },
    };
    screenFor();
    const row = screen.getAllByRole("listitem").find((r) => r.getAttribute("data-session-id") === "s1") as HTMLElement;
    expect(within(row).getByRole("link", { name: /^ISS-7/ })).toBeInTheDocument();
    expect(within(row).getByText(sentence)).toBeInTheDocument();
    const held = screen.getAllByRole("listitem").find((r) => r.getAttribute("data-issue-id") === "i7") as HTMLElement;
    expect(within(held).getByText((text) => text.endsWith(`. ${sentence}`))).toBeInTheDocument();
  });

  it("says nothing of a disagreement where the box and core agree", () => {
    const { container } = screenFor();
    expect(container.textContent).not.toMatch(/The box says it returned/);
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

  it("says what failed in the product's words, and keeps the server's code and message under Technical details", () => {
    const error = new ApiError(500, "Internal Server Error", "INTERNAL_ERROR");
    query = { data: undefined, isError: true, error, refetch: vi.fn() };
    screenFor();
    expect(screen.getByText("The server ran into a problem and could not finish the request.")).toBeInTheDocument();
    const details = screen.getByText("Technical details").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(within(details as HTMLElement).getByText("500 INTERNAL_ERROR — Internal Server Error")).toBeInTheDocument();
  });

  // Round 23 (judge-74, criterion 226): under this 409 the page said "Something changed since this page
  // loaded. Reload it, then try again." and kept core's sentence behind Technical details.
  const refusal = "The holds could not be read while a migration holds the table. Try again in a minute.";

  it("gives a refusal's own sentence when the first read is refused", () => {
    query = { data: undefined, isError: true, error: new ApiError(409, refusal, "HOLDS_READ_REFUSED"), refetch: vi.fn() };
    screenFor();
    expect(screen.getByText(refusal)).toBeInTheDocument();
    expect(screen.queryByText(/Something changed since this page loaded/)).toBeNull();
  });

  it("gives a refusal's own sentence when a refresh is refused, over the reading it keeps", () => {
    query = { ...query, data: reading, isError: true, error: new ApiError(409, refusal, "HOLDS_READ_REFUSED") };
    screenFor();
    expect(screen.getByRole("status")).toHaveTextContent(`. ${refusal}`);
    expect(screen.queryByText(/Something changed since this page loaded/)).toBeNull();
  });

  // Round 23 (judge-74, criteria 233 and 234): a failed refresh said so but offered no way to try again.
  it("offers Retry beside a failed refresh, keeps the rows while it runs, and shows no live dot", () => {
    const lost = new TypeError("Failed to fetch");
    markUnreachable(lost);
    const refetch = vi.fn();
    query = { data: reading, isError: true, error: lost, refetch };
    const { container } = screenFor();
    screen.getByRole("button", { name: /retry/i }).click();
    expect(refetch).toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "Live sessions" })).toBeInTheDocument();
    expect(container.querySelector(".forge-pulse")).toBeNull();
  });

  it("shows the live dot while its read stands", () => {
    query = { data: reading, isError: false, error: null, refetch: vi.fn() };
    const { container } = screenFor();
    expect(container.querySelector(".forge-pulse")).not.toBeNull();
  });

  it("keeps the last reading when a refresh fails, and says when it was read and why the refresh failed", () => {
    const lost = new TypeError("Failed to fetch");
    markUnreachable(lost);
    query = { ...query, isError: true, error: lost };
    screenFor();
    expect(screen.getByRole("status")).toHaveTextContent(
      /^Could not refresh — showing what was read at \d\d:\d\d\. Forge could not be reached\. Check your connection, then try again\.$/,
    );
    expect(screen.getByRole("list", { name: "Live sessions" })).toBeInTheDocument();
  });
});

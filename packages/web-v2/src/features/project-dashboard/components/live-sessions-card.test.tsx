// @vitest-environment jsdom
//
// The dashboard's live block lists the sessions the Pipeline page lists, in the same words, and
// counts the open runs nothing works under them rather than as rows.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveSession } from "@/features/pipeline/types";
import type { PipelineRunListItem } from "@/features/runs/types";
import { LiveSessionsCard } from "./live-sessions-card";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));

const NOW = Date.parse("2026-10-15T05:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

const session = (over: Partial<LiveSession> = {}): LiveSession => ({
  id: "s1",
  kind: "run_session",
  title: null,
  status: "running",
  runtimeState: null,
  deviceId: "d1",
  deviceName: "box-1",
  parentSessionId: null,
  startedAt: ago(600),
  lastHeartbeatAt: ago(4),
  createdAt: ago(600),
  issues: [{ issueId: "i9", displayId: "ISS-9", title: "Nine" }],
  report: null,
  ...over,
});

const run = { id: "r1", status: "running", liveJobs: 0, lastSessionBeatAt: null } as unknown as PipelineRunListItem;

describe("the dashboard's live sessions", () => {
  it("lists each live session with what it is doing, the issue it holds and its check-in", () => {
    render(<LiveSessionsCard sessions={[session()]} slug="pair" now={NOW} read={{ read: "ok" }} />);
    const block = screen.getByRole("region", { name: "Live sessions" });
    const row = within(block).getByRole("listitem");
    expect(row).toHaveTextContent("Working");
    expect(within(row).getByRole("link", { name: "Agent" })).toHaveAttribute("href", "/projects/pair/agents/s1");
    expect(within(row).getByRole("link", { name: "ISS-9" })).toHaveAttribute("href", "/projects/pair/issues/i9");
    expect(row).toHaveTextContent("4s ago");
    expect(block).not.toHaveTextContent("none live");
  });

  // ISS-1228 r9: at 390 a step session's name read "Issue work: Rename the expor…", with no hover to
  // show the rest.
  it("wraps a session's name below sm rather than cutting it, and says it whole on hover from sm up", () => {
    const name = "Issue work: Rename the export column";
    render(<LiveSessionsCard sessions={[session({ title: name })]} slug="pair" now={NOW} read={{ read: "ok" }} />);
    const link = screen.getByRole("link", { name });
    const tokens = link.className.split(/\s+/);
    expect(tokens).not.toContain("truncate");
    expect(tokens).toEqual(expect.arrayContaining(["break-words", "sm:truncate"]));
    expect(link).toHaveAttribute("title", name);
  });

  it("marks a running session silent past a minute quiet", () => {
    render(<LiveSessionsCard sessions={[session({ lastHeartbeatAt: ago(300) })]} slug="pair" now={NOW} read={{ read: "ok" }} />);
    expect(screen.getByText("Quiet · 5m ago")).toBeInTheDocument();
  });

  it("states the zero once the read is in, and counts the open runs nothing works", () => {
    render(<LiveSessionsCard sessions={[]} idle={[run, { ...run, id: "r2" }]} slug="pair" now={NOW} read={{ read: "ok" }} runsRead={{ read: "ok" }} />);
    expect(screen.getByText("none live right now")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2 open runs have nothing working them/ })).toBeInTheDocument();
  });

  it("says no idle count while the runs read is out", () => {
    render(<LiveSessionsCard sessions={[]} idle={[run]} slug="pair" now={NOW} read={{ read: "ok" }} runsRead={{ read: "pending" }} />);
    expect(screen.queryByText(/nothing working/)).toBeNull();
  });

  it("names the sessions read while it is out, and states no session and none live", () => {
    render(<LiveSessionsCard sessions={[]} idle={[run]} slug="pair" now={NOW} read={{ read: "pending" }} runsRead={{ read: "ok" }} />);
    expect(screen.getByText("The project's live sessions are still being read.")).toBeInTheDocument();
    expect(screen.queryByText(/none live/)).toBeNull();
    expect(screen.queryByText(/nothing working/)).toBeNull();
  });

  it("names why the sessions read failed", () => {
    render(<LiveSessionsCard sessions={[]} slug="pair" now={NOW} read={{ read: "failed", reason: "Gateway Timeout" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The project's live sessions could not be read: Gateway Timeout");
  });
});

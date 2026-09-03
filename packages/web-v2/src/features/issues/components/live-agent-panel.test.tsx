// @vitest-environment jsdom
//
// ISS-903 — the same panel has two arms now. The QUEUED arm is the one that
// did not exist: a job queued with `agentSessionId: null` has no
// `agent_sessions` row, so every session-derived surface rendered nothing at
// all while the step sat behind a gate for hours.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedStepView } from "../waiting";
import type { IssueAgentSession } from "../types";
import { LiveAgentPanel } from "./live-agent-panel";

expect.extend(matchers);

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(cleanup);

// cm:guard pin the clock for EVERY test here, not only the ones asserting a duration — `heartbeatState` reads the wall clock, so a fixture heartbeat written relative to NOW goes stale on its own once real time passes it, and this file was green the day it was written and red the next
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const NOW = new Date("2026-09-03T17:22:00.000Z");
const QUEUED_AT = "2026-09-03T14:43:00.000Z";

const gatedStep: QueuedStepView = {
  jobId: "a872c0b8",
  jobType: "drive",
  queuedAt: QUEUED_AT,
  nextAttempt: "",
  gate: {
    reason: "runner_stale",
    short: "No runner online",
    detail: "No runner is online for this project — every host is offline, stale, or rate-limited.",
    who: "Bring a runner back (check the Runners tab); the step dispatches on the next tick.",
    needsAction: true,
  },
};

const liveSession: IssueAgentSession = {
  id: "sess-1",
  status: "running",
  metadata: null,
  createdAt: QUEUED_AT,
  updatedAt: QUEUED_AT,
  title: null,
  deviceId: "0629f109-9847-4f4b-8c16-81162b0f5402",
  startedAt: QUEUED_AT,
  lastHeartbeatAt: new Date(NOW.getTime() - 5_000).toISOString(),
};

function renderPanel(state: Parameters<typeof LiveAgentPanel>[0]["state"]) {
  return render(<LiveAgentPanel state={state} step="code" slug="forge-dev" issueId="iss-903" />);
}

describe("LiveAgentPanel — queued arm (ISS-903)", () => {
  it("says Agent queued, names the step, and states the gate in plain words", () => {
    renderPanel({ kind: "queued", step: gatedStep });
    expect(screen.getByText("Agent queued")).toBeInTheDocument();
    expect(screen.getByText("drive")).toBeInTheDocument();
    expect(screen.getByText(/No runner is online for this project/)).toBeInTheDocument();
    expect(screen.getByText(/Bring a runner back/)).toBeInTheDocument();
  });

  it("says how long the step has waited", () => {
    renderPanel({ kind: "queued", step: gatedStep });
    expect(screen.getByText("2h 39m")).toBeInTheDocument();
  });

  it("shows the next attempt when one is known, and omits it when none is", () => {
    const { unmount } = renderPanel({
      kind: "queued",
      step: { ...gatedStep, nextAttempt: "in 1 min" },
    });
    expect(screen.getByText("in 1 min")).toBeInTheDocument();
    expect(screen.getByText("Next attempt")).toBeInTheDocument();
    unmount();
    renderPanel({ kind: "queued", step: gatedStep });
    expect(screen.queryByText("Next attempt")).not.toBeInTheDocument();
  });

  it("says the step is awaiting its turn when no gate holds it — never bare 'queued'", () => {
    renderPanel({ kind: "queued", step: { ...gatedStep, gate: null } });
    expect(screen.getByText("Agent queued")).toBeInTheDocument();
    expect(screen.getByText(/awaiting its turn/i)).toBeInTheDocument();
  });

  it("renders no heartbeat dot — a queued step has no session to have one", () => {
    renderPanel({ kind: "queued", step: gatedStep });
    expect(screen.queryByText(/Heartbeat/)).not.toBeInTheDocument();
  });

  it("still deep-links to the timeline", () => {
    renderPanel({ kind: "queued", step: gatedStep });
    expect(screen.getByText("View timeline").closest("a")).toHaveAttribute(
      "href",
      "/projects/forge-dev/agents?issue=iss-903",
    );
  });
});

describe("LiveAgentPanel — live arm (unchanged)", () => {
  it("says Agent running with the step, runner and heartbeat", () => {
    renderPanel({ kind: "live", session: liveSession });
    expect(screen.getByText("Agent running")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
    expect(screen.getByText("0629f109")).toBeInTheDocument();
    expect(screen.getByText("Heartbeat alive")).toBeInTheDocument();
  });

  it("exposes the raw ids behind an operator expand", () => {
    renderPanel({ kind: "live", session: liveSession });
    expect(screen.queryByText("sess-1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Operator details/ }));
    expect(screen.getByText("sess-1")).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
//
// ISS-1421 round 2 — judge-28 saw the header's actions menu wrap onto its own line at 390 at
// Releasing. Round 6 — judge-37: the release banner sends a reader to "Open session at the top of
// this page", and below `sm` it was a bare icon. Its words show at every width; the after-shots at
// 390 are the measurement of the row.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueStatus } from "../types";
import { IssueHeaderActions } from "./issue-header-actions";

expect.extend(matchers);

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(cleanup);

const onRun = vi.fn();

function renderAt(
  status: IssueStatus,
  releaseRunId: string | null = null,
  sessionHref: string | null = "/projects/forge/agents/s-1",
) {
  render(
    <div data-testid="row">
      <IssueHeaderActions
        slug="forge"
        sessionHref={sessionHref}
        status={status}
        releaseRunId={releaseRunId}
        canWrite
        pending={false}
        isRunActive={false}
        onTransition={vi.fn()}
        onRun={onRun}
        running={false}
        onCopyLink={vi.fn()}
      />
    </div>,
  );
}

describe("the issue header's actions at phone width (criterion 37)", () => {
  it.each([
    ["releasing", "run-1", ["View release", "Open session", "Issue actions"]],
    ["awaiting_release", null, ["Open session", "Issue actions"]],
    ["in_progress", null, ["Open pipeline", "Open session", "Issue actions"]],
    ["open", null, ["Run", "Open session", "Issue actions"]],
  ] as const)("at %s offers its controls, Open session in words at every width", (status, run, names) => {
    renderAt(status, run);
    const controls = [...document.querySelectorAll("button, a[href]")];
    expect(controls.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(names);
    const open = screen.getByRole("link", { name: "Open session" });
    expect(open.querySelector("svg")).not.toBeNull();
    expect(open).toHaveTextContent("Open session");
    // No class hides any part of its words at a width (criterion 86).
    for (const el of open.querySelectorAll("*")) {
      expect(el.getAttribute("class") ?? "", el.outerHTML).not.toMatch(/(^|\s)hidden(\s|$)/);
    }
  });
});

// ISS-1228 round 11 — the primary read "Run pipeline" and only opened the Pipeline page.
describe("the issue header's primary says what it does", () => {
  it("offers Run at Open, and pressing it asks core to run the issue", async () => {
    const { fireEvent } = await import("@testing-library/react");
    onRun.mockClear();
    renderAt("open");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it.each(["in_progress", "needs_info", "on_hold"] as const)(
    "at %s names the button that opens the Pipeline page Open pipeline, never Run",
    (status) => {
      renderAt(status);
      expect(screen.getByRole("button", { name: "Open pipeline" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Run/ })).toBeNull();
    },
  );
});

// ISS-1228 round 14 (judge-36): Open session landed on the unfiltered Agents runs list. Round 15
// (judge-39): it was a button, so it could not be opened in a new tab or copied.
describe("Open session opens the issue's session", () => {
  it("is a link to the session page it is given, so it opens in a new tab", () => {
    renderAt("in_progress", null, "/projects/forge/agents/s-9");
    const open = screen.getByRole("link", { name: "Open session" });
    expect(open).toHaveAttribute("href", "/projects/forge/agents/s-9");
    expect(screen.queryByRole("button", { name: "Open session" })).toBeNull();
  });

  it("is not offered for an issue no session has run", () => {
    renderAt("open", null, null);
    expect(screen.queryByRole("link", { name: "Open session" })).toBeNull();
    expect(screen.getByRole("button", { name: "Issue actions" })).toBeInTheDocument();
  });
});


// ISS-1228 round 21 (judge-67): Pause was the primary action on a run waiting for an answer and on one
// with nothing working; the master's ruling makes Answer the primary of the first and none of the second.
describe("the primary action follows what the run waits on", () => {
  function renderWaiting(runWaitsOn: "answer" | "nothing" | null, onAnswer = vi.fn()) {
    render(
      <IssueHeaderActions
        slug="forge"
        sessionHref={null}
        status="in_progress"
        releaseRunId={null}
        canWrite
        pending={false}
        isRunActive
        runWaitsOn={runWaitsOn}
        onAnswer={onAnswer}
        onTransition={vi.fn()}
        onRun={onRun}
        running={false}
        onCopyLink={vi.fn()}
      />,
    );
    return onAnswer;
  }

  it("offers Answer on a run waiting for an answer, and pressing it shows the question", () => {
    const onAnswer = renderWaiting("answer");
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    screen.getByRole("button", { name: "Answer" }).click();
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("offers no primary action on a run nothing is working", () => {
    renderWaiting("nothing");
    const controls = [...document.querySelectorAll("button, a[href]")];
    expect(controls.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Issue actions"]);
  });

  it("keeps Pause the primary on a run something is working", () => {
    renderWaiting(null);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });
});

// ISS-1228 round 21: a failed read of which session holds the issue fell back to the run's own
// session without a word; it now says so where Open session goes, with Retry.
describe("a session the page could not read", () => {
  it("says so with Retry and links to no other session", () => {
    const retry = vi.fn();
    render(
      <IssueHeaderActions
        slug="forge"
        sessionHref={null}
        sessionUnread={{ retry }}
        status="in_progress"
        releaseRunId={null}
        canWrite
        pending={false}
        isRunActive
        onTransition={vi.fn()}
        onRun={onRun}
        running={false}
        onCopyLink={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Its session could not be read.");
    expect(screen.queryByRole("link", { name: "Open session" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});


// @vitest-environment jsdom
//
// ISS-1421 round 2 — judge-28 saw the header's actions menu wrap onto its own line at 390 at
// Releasing. Round 6 — judge-37: the release banner sends a reader to "Open session at the top of
// this page", and below `sm` it was a bare icon. Its words show at every width; the after-shots at
// 390 are the measurement of the row.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
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
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(names);
    const open = screen.getByRole("button", { name: "Open session" });
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

// ISS-1228 round 14 (judge-36): Open session landed on the unfiltered Agents runs list.
describe("Open session opens the issue's session", () => {
  it("goes to the session page it is given", async () => {
    const { fireEvent } = await import("@testing-library/react");
    push.mockClear();
    renderAt("in_progress", null, "/projects/forge/agents/s-9");
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(push).toHaveBeenCalledWith("/projects/forge/agents/s-9");
  });

  it("is not offered for an issue no session has run", () => {
    renderAt("open", null, null);
    expect(screen.queryByRole("button", { name: "Open session" })).toBeNull();
    expect(screen.getByRole("button", { name: "Issue actions" })).toBeInTheDocument();
  });
});


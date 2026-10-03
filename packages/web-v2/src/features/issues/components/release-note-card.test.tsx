// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReleaseNotes } from "@forge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkStep } from "@forge/contracts/issue-vocabulary";
import type { IssueStatus } from "../types";
import { ReleaseNoteCard } from "./release-note-card";

expect.extend(matchers);
afterEach(cleanup);

const FIXED: ReleaseNotes = {
  section: "Fixed",
  userFacing: "The invoice PDF now shows the customer's billing address.",
};
const SKIP: ReleaseNotes = { section: "Skip", userFacing: "-" };

function show(
  status: IssueStatus,
  releaseNotes: ReleaseNotes | null | undefined,
  step: WorkStep | null = null,
) {
  return render(<ReleaseNoteCard issue={{ status, releaseNotes, workState: { step } }} />);
}

describe("the release note on an issue's page", () => {
  it("says what changed on a closed issue, in the note's own words", () => {
    show("closed", FIXED);
    expect(screen.getByText("What changed")).toBeInTheDocument();
    expect(screen.getByText(FIXED.userFacing)).toBeInTheDocument();
  });

  it("speaks of a change still to ship at Awaiting release, the status the done page names", () => {
    show("awaiting_release", FIXED);
    expect(screen.getByText("What will change once it ships")).toBeInTheDocument();
  });

  it("speaks of a change still to ship while a run tests what it built (In progress · Test)", () => {
    show("in_progress", FIXED, "test");
    expect(screen.getByText("What will change once it ships")).toBeInTheDocument();
    expect(screen.getByText(FIXED.userFacing)).toBeInTheDocument();
  });

  it.each(["triage", "clarify", "plan", "build"] as const)(
    "keeps a neutral heading at In progress · %s, where nothing is built yet",
    (step) => {
      show("in_progress", FIXED, step);
      expect(screen.getByText("Release note")).toBeInTheDocument();
      expect(screen.queryByText("What will change once it ships")).toBeNull();
    },
  );

  it("does not read a test step off any status but in_progress", () => {
    show("needs_info", FIXED, "test");
    expect(screen.getByText("Release note")).toBeInTheDocument();
  });

  it.each(["draft", "open", "approved", "reopen", "needs_info", "on_hold", "in_progress"] as const)(
    "keeps a neutral heading at %s, where nothing says whether it shipped",
    (status) => {
      show(status, FIXED);
      expect(screen.getByText("Release note")).toBeInTheDocument();
      expect(screen.queryByText("What will change once it ships")).toBeNull();
      expect(screen.queryByText("What changed")).toBeNull();
    },
  );

  it("says nothing you would see changed when the note records no user-facing part", () => {
    show("closed", SKIP);
    expect(screen.getByText("What changed")).toBeInTheDocument();
    expect(screen.getByText(/Nothing you would see changed/)).toBeInTheDocument();
    expect(screen.queryByText("-")).toBeNull();
  });

  it.each([null, undefined])("draws nothing when the issue carries no note (%s)", (note) => {
    const { container } = show("closed", note);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the note's markdown instead of showing its markup", () => {
    const { container } = show(
      "in_progress",
      {
        section: "Fixed",
        userFacing: "Run `forge-runner status` to see **which** version is live.",
      },
      "test",
    );
    expect(container.textContent).toContain("Run forge-runner status to see which version is live.");
    expect(container.textContent).not.toMatch(/[`*]/);
    expect(container.querySelector("code")).toHaveTextContent("forge-runner status");
  });

  it("draws nothing on a dropped issue, whatever note it carries", () => {
    const { container } = show("dropped", FIXED);
    expect(container).toBeEmptyDOMElement();
  });
});

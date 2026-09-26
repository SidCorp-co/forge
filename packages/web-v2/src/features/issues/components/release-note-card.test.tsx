// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReleaseNotes } from "@forge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { IssueStatus } from "../types";
import { BUILT_NOT_RELEASED, ReleaseNoteCard } from "./release-note-card";

expect.extend(matchers);
afterEach(cleanup);

const FIXED: ReleaseNotes = {
  section: "Fixed",
  userFacing: "The invoice PDF now shows the customer's billing address.",
};
const SKIP: ReleaseNotes = { section: "Skip", userFacing: "-" };

function show(status: IssueStatus, releaseNotes: ReleaseNotes | null | undefined) {
  return render(<ReleaseNoteCard issue={{ status, releaseNotes }} />);
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

  it.each([...BUILT_NOT_RELEASED])(
    "speaks of a change still to ship at %s",
    (status) => {
      show(status, FIXED);
      expect(screen.getByText("What will change once it ships")).toBeInTheDocument();
      expect(screen.getByText(FIXED.userFacing)).toBeInTheDocument();
    },
  );

  it.each(["reopen", "needs_info", "on_hold", "in_progress"] as const)(
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

  it("draws nothing on a dropped issue, whatever note it carries", () => {
    const { container } = show("dropped", FIXED);
    expect(container).toBeEmptyDOMElement();
  });
});

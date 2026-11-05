// A release says what splitting does: the page carries no banner since ISS-1001, so the one act's
// button says it, on hover and focus, in the words core gave the wait.

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ReleaseActions } from "./release-actions";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const EFFECT = "Cuts the oldest 50 merged issues; the other 13 wait for the next release.";
const release = {
  version: "0.1.0",
  state: "draft",
  attentionGroup: "needs_you",
  approvalRequired: true,
  approval: null,
  approvers: [],
  issues: [],
  can: { cut: false, decide: false, split: true },
  split: { issueIds: ["i1"], rest: 13 },
  waitingOn: { kind: "you", who: "You", act: "split this release into smaller releases", rule: "r", effect: EFFECT, ref: null, dueAt: null },
};

describe("a release that has to be split", () => {
  it("says what splitting does on its one act", () => {
    renderWithQuery(<ReleaseActions projectId="p1" r={release as never} />);
    expect(screen.getByTestId("release-split")).toHaveAttribute("title", EFFECT);
    expect(screen.queryByTestId("wait-effect")).toBeNull();
  });
});

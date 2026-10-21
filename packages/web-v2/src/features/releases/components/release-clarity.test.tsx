// A release says why it asks to be split and what splitting does, and its rail says where it stands in
// plain words at every width: the template places the rail on a phone (detail-rail-place.test.tsx).

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReleaseBanner } from "./release-bits";
import { WhereReleaseStands } from "./release-rail";

const release = {
  version: "0.1.0",
  state: "draft",
  attentionGroup: "needs_you",
  approvalRequired: true,
  approval: null,
  approvers: [],
  waitingOn: { kind: "you", who: "You", act: "split this release into smaller releases", rule: "r", effect: "Cuts the oldest 50 merged issues; the other 13 wait for the next release.", ref: null, dueAt: null },
};

describe("a release that has to be split", () => {
  it("says what splitting does under the banner", () => {
    render(<ReleaseBanner r={release as never} />);
    expect(screen.getByTestId("wait-effect")).toHaveTextContent("Cuts the oldest 50 merged issues; the other 13 wait for the next release.");
  });
});

describe("a release's rail, in plain words (BC-19)", () => {
  const draft = { ...release, releasedAt: null, production: null, verified: { level: "none", proven: 0, total: 0, check: null, provider: null } };

  it("says its status, approver, where it goes, what was checked and the next step, at every width", () => {
    const { container } = render(<WhereReleaseStands r={draft as never} />);
    expect(screen.getByTestId("standing-status")).toHaveTextContent("Not cut yet");
    expect(screen.getByTestId("standing-approver")).toHaveTextContent("A project admin");
    expect(screen.getByTestId("standing-goes-to")).toHaveTextContent("No production");
    expect(screen.getByTestId("standing-verified")).toHaveTextContent("Not checked yet");
    expect(screen.getByTestId("standing-next")).toHaveTextContent("Next: Add a production environment, then cut");
    expect(container.innerHTML).not.toMatch(/max-(sm|md|lg):hidden/);
  });

  it("asks for the cut only once the release has somewhere to go", () => {
    render(<WhereReleaseStands r={{ ...draft, production: { name: "production", url: null } } as never} />);
    expect(screen.getByTestId("standing-next")).toHaveTextContent("Next: Cut the release");
  });

  it("names none of the pipeline's words: no forecast, no run, no list of who can decide", () => {
    const { container } = render(<WhereReleaseStands r={{ ...draft, state: "awaiting_approval", production: { name: "production", url: null }, approvers: [{ id: "u", name: "orchestrator", kind: "agent" }] } as never} />);
    for (const word of ["Forecast", "Not cut yet: no run", "Can decide", "orchestrator", "Run"]) expect(container).not.toHaveTextContent(word);
    expect(screen.getByTestId("standing-next")).toHaveTextContent("Next: Approve the release");
  });
});

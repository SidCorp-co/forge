// The release page lists the feedback it answers, each with who asked and whether the release told them.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReleaseDetail, ReleaseFeedbackView } from "../types";
import { FeedbackAnswered } from "./release-panes";

const item = (over: Partial<ReleaseFeedbackView>): ReleaseFeedbackView => ({
  key: "FB-91",
  title: "About has no type for a tool",
  reporter: "orchestrator",
  agency: "human",
  told: "told",
  toldAt: "2026-10-07T08:00:00Z",
  ...over,
});
const release = (feedbackAnswered: ReleaseFeedbackView[]) =>
  ({
    feedbackAnswered,
    feedbackToldCounts: Object.fromEntries((["on_ship", "told", "not_told", "before_notices"] as const).map((k) => [k, feedbackAnswered.filter((f) => f.told === k).length])),
  }) as unknown as ReleaseDetail;

describe("Feedback answered on a release", () => {
  it("renders nothing when the release carries no feedback", () => {
    const { container } = render(<FeedbackAnswered r={release([])} slug="forge" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each item with its reporter and told state, linking to the feedback, never to an issue", () => {
    render(
      <FeedbackAnswered
        r={release([item({}), item({ key: "FB-92", told: "not_told", toldAt: null }), item({ key: "FB-93", told: "on_ship", toldAt: null }), item({ key: "FB-94", told: "not_told", agency: "agent", toldAt: null })])}
        slug="forge"
      />,
    );
    const rows = screen.getAllByTestId("release-feedback-row");
    expect(rows).toHaveLength(4);
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "FB-91" }).getAttribute("href")).toBe("/projects/forge/feedback/FB-91");
    expect(rows[0]?.textContent).toContain("orchestrator · Reporter told");
    expect(rows[1]?.textContent).toContain("Reporter was not told");
    expect(rows[2]?.textContent).toContain("told when this release ships");
    expect(rows[3]?.textContent).toContain("an agent");
    expect(screen.getByTestId("release-feedback-counts").textContent).toBe("1 told · 2 not told · 1 told when it ships");
    expect(screen.queryAllByRole("link").every((a) => a.getAttribute("href")?.includes("/feedback/"))).toBe(true);
  });

  it("names an item that shipped before release notices existed, and counts it apart", () => {
    render(<FeedbackAnswered r={release([item({ key: "FB-95", told: "before_notices", toldAt: null }), item({})])} slug="forge" />);
    const rows = screen.getAllByTestId("release-feedback-row");
    expect(rows[0]?.textContent).toContain("Shipped before release notices existed: not told");
    expect(screen.getByTestId("release-feedback-counts").textContent).toBe("1 told · 1 shipped before release notices existed");
  });
});

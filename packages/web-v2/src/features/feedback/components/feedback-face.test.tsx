// The feedback page's face (ISS-903): the title leads with its key the title's tooltip, never text
// beside it; the facts open in a Properties drawer, never a rail beside the page; and the person /
// developer switch is the palette's, not a control on the face.
//
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-detail.tsx
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-item-screen.tsx

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { feedbackDetail, ITEM } from "@/test/vi-chrome-feedback";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

Element.prototype.scrollIntoView = () => {};

describe("the feedback page's face", () => {
  it("leads with the title, its key the tooltip", async () => {
    render(feedbackDetail());
    const title = await screen.findByTestId("feedback-title");
    expect(title).toHaveAttribute("title", ITEM.key);
    expect(title.textContent).toBe(ITEM.title);
    expect(screen.queryAllByText(ITEM.key, { exact: true })).toHaveLength(0);
  });

  it("opens the facts in a Properties drawer, and draws no view switch on the face", async () => {
    const user = userEvent.setup();
    render(feedbackDetail());
    await screen.findByTestId("feedback-detail");
    expect(screen.queryByTestId("record-view-switch")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByTestId("feedback-properties"));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "Properties" })).toBeInTheDocument();
  });
});

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { entry, feedOf, NOW } from "../fixtures";
import { WhatsNewPanel } from "./whats-new-panel";

const entries = [
  entry("ISS-1", "new", "2026-10-07T08:00:00Z", { title: "A release page says what it changes.", body: "Read it first." }),
  entry("ISS-2", "improved", "2026-10-06T08:00:00Z", { title: "Integrations reads true." }),
  entry("ISS-3", "fixed", "2026-10-06T07:00:00Z", { title: "A blocked release names its owner." }),
  entry("ISS-4", "fixed", "2026-09-29T07:00:00Z", { title: "An old fix." }),
];

describe("the What's new panel", () => {
  it("leads with the since-line and keeps fixes collapsed until asked", async () => {
    renderWithQuery(
      <WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feedOf(entries, { counts: { new: 1, improved: 1, fixed: 2 } })} />,
    );
    expect(screen.getByTestId("whats-new-since")).toHaveTextContent("Since your last visit (03/10): 4 changes · 1 new, 1 improvements, 2 fixes");
    expect(screen.queryByText("A blocked release names its owner.")).toBeNull();
    const yesterday = screen.getByTestId("whats-new-section-yesterday");
    await userEvent.click(within(yesterday).getByRole("button", { name: "Show" }));
    expect(screen.getByText("A blocked release names its owner.")).toBeInTheDocument();
  });

  it("counts a first look over the window core read, 7 days, not a fixed 30", () => {
    const feed = feedOf(entries.slice(0, 3), { seenAt: null, since: "2026-09-30T10:00:00Z", counts: { new: 1, improved: 1, fixed: 1 } });
    renderWithQuery(<WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feed} />);
    expect(screen.getByTestId("whats-new-since")).toHaveTextContent("The last 7 days: 3 changes");
  });

  it("summarises for a reader away seven days, three highlights, the rest behind one button", async () => {
    const feed = feedOf(entries, {
      seenAt: "2026-09-28T08:00:00Z",
      away: { since: "2026-09-28T08:00:00Z", days: 9, counts: { new: 1, improved: 1, fixed: 2 }, highlights: ["ISS-1", "ISS-2", "ISS-3"] },
    });
    renderWithQuery(<WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feed} />);
    expect(screen.getByTestId("whats-new-away")).toHaveTextContent("Since 28/09: 1 new, 1 improvements, 2 fixes");
    const highlights = within(screen.getByTestId("whats-new-away")).getAllByTestId("whats-new-entry");
    expect(highlights.map((h) => h.textContent)).toEqual([
      expect.stringContaining("A release page says what it changes."),
      expect.stringContaining("Integrations reads true."),
      expect.stringContaining("A blocked release names its owner."),
    ]);
    expect(screen.queryByText("An old fix.")).toBeNull();
    await userEvent.click(screen.getByTestId("whats-new-show-rest"));
    expect(screen.getByTestId("whats-new-section-2026-W40")).toBeInTheDocument();
  });

  it("shows an entry as its bold lead and body, with the version beside it and no link to a release page", () => {
    renderWithQuery(<WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feedOf(entries)} />);
    const row = within(screen.getByTestId("whats-new-section-today")).getByTestId("whats-new-entry");
    expect(row).toHaveTextContent("A release page says what it changes. Read it first.");
    expect(within(row).getByText("A release page says what it changes.")).toHaveClass("font-semibold");
    expect(within(row).getByText("0.4.0-dev.87")).toBeInTheDocument();
    expect(within(row).queryByRole("link")).toBeNull();
  });

  it("shows a week's digest by its own title and body", () => {
    const feed = feedOf(entries, {
      digests: [{ week: "2026-W41", title: "The week in Forge.", body: "Screens and fixes.", version: "0.4.0-dev.91", releasedAt: "2026-10-07T00:00:00.000Z" }],
    });
    renderWithQuery(<WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feed} />);
    expect(screen.getByTestId("whats-new-digest")).toHaveTextContent("The week in Forge. Screens and fixes.");
  });
});

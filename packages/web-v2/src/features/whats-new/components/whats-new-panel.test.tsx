import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { entry, feedOf, NOW } from "../fixtures";
import { WhatsNewPanel } from "./whats-new-panel";

const entries = [
  entry("ISS-1", "new", "2026-10-07T08:00:00Z", { ui: true, text: "A release page says what it changes." }),
  entry("ISS-2", "improved", "2026-10-06T08:00:00Z", { text: "Integrations reads true." }),
  entry("ISS-3", "fixed", "2026-10-06T07:00:00Z", { text: "A blocked release names its owner." }),
  entry("ISS-4", "fixed", "2026-09-29T07:00:00Z", { text: "An old fix." }),
];

describe("the What's new panel", () => {
  it("leads with the since-line and keeps fixes collapsed until asked", async () => {
    renderWithQuery(
      <WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feedOf(entries, { counts: { new: 1, screens: 1, improved: 1, fixed: 2 } })} />,
    );
    expect(screen.getByTestId("whats-new-since")).toHaveTextContent("Since your last visit (03/10): 4 changes · 1 new, 1 improvements, 2 fixes");
    expect(screen.queryByText("A blocked release names its owner.")).toBeNull();
    const yesterday = screen.getByTestId("whats-new-section-yesterday");
    await userEvent.click(within(yesterday).getByRole("button", { name: "Show" }));
    expect(screen.getByText("A blocked release names its owner.")).toBeInTheDocument();
  });

  it("summarises for a reader away seven days, three highlights, the rest behind one button", async () => {
    const feed = feedOf(entries, {
      seenAt: "2026-09-28T08:00:00Z",
      away: { since: "2026-09-28T08:00:00Z", days: 9, counts: { new: 1, screens: 1, improved: 1, fixed: 2 }, highlights: ["ISS-1", "ISS-2", "ISS-3"] },
    });
    renderWithQuery(<WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feed} />);
    expect(screen.getByTestId("whats-new-away")).toHaveTextContent("Since 28/09: 1 new screens, 1 improvements, 2 fixes");
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

  it("writes its chrome in the platform project's content language", () => {
    renderWithQuery(<WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feedOf(entries, { contentLanguage: "vi" })} />);
    expect(screen.getByTestId("whats-new-section-today")).toHaveTextContent("Hôm nay"); // i18n-allow: asserts the vi locale file
    expect(screen.getByTestId("whats-new-filter-all")).toHaveTextContent("Tất cả"); // i18n-allow: asserts the vi locale file
  });

  it("links an entry's version to its release page", () => {
    renderWithQuery(<WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feedOf(entries)} />);
    const link = within(screen.getByTestId("whats-new-section-today")).getByRole("link", { name: "0.4.0-dev.87" });
    expect(link).toHaveAttribute("href", "/projects/forge/releases/0.4.0-dev.87");
  });

  it("offers an entry's tour as Show me, linking to the page it runs on", () => {
    const withTour = [entry("ISS-319", "new", "2026-10-07T08:00:00Z", { ui: true, tour: { id: "release-what-changes", revision: 1 } })];
    renderWithQuery(<WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feedOf(withTour)} />);
    const link = screen.getByTestId("whats-new-tour-link");
    expect(link).toHaveTextContent("Show me · 3 steps");
    expect(link).toHaveAttribute("href", "/projects/forge/releases/0.4.0-dev.87?tour=release-what-changes");
  });
});

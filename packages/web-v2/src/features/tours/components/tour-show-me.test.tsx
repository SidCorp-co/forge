// A What's new entry an issue's tour belongs to offers "Show me", a link that opens the tour on the
// page it runs on; an entry no tour belongs to offers nothing beside its version.

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WhatsNewPanel } from "@/features/whats-new/components/whats-new-panel";
import { entry, feedOf, NOW } from "@/features/whats-new/fixtures";
import { fakeCore, renderWithQuery } from "@/test/render";
import { tourShowMe } from "./tour-show-me";

describe("Show me on a What's new entry", () => {
  it("links an entry's tour to the page it runs on, with the step count", async () => {
    const feed = feedOf([entry("ISS-319", "new", "2026-10-07T08:00:00Z", { ui: true, tour: { id: "release-what-changes", revision: 1 } })]);
    fakeCore((call) => (call.path.startsWith("/me/whats-new") ? { body: feed } : undefined));
    renderWithQuery(<WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feed} entryAction={tourShowMe} />);
    const link = await screen.findByTestId("whats-new-tour-link");
    expect(link).toHaveTextContent("Show me · 3 steps");
    expect(link).toHaveAttribute("href", "/projects/forge/releases/0.4.0-dev.87?tour=release-what-changes");
  });

  it("offers nothing for an entry no tour belongs to", () => {
    const feed = feedOf([entry("ISS-2", "improved", "2026-10-07T08:00:00Z")]);
    fakeCore((call) => (call.path.startsWith("/me/whats-new") ? { body: feed } : undefined));
    renderWithQuery(<WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feed} entryAction={tourShowMe} />);
    expect(screen.getByText("ISS-2 text")).toBeInTheDocument();
    expect(screen.queryByTestId("whats-new-tour-link")).toBeNull();
  });
});

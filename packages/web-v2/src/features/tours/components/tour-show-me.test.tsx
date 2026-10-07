// A What's new entry whose changelog fragment named a tour offers "Show me", a link that opens the
// tour on a page of the open project; an entry that named none offers nothing beside its version.

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CurrentProjectProvider } from "@/features/projects/current-project";
import type { ProjectListItem } from "@/features/projects/types";
import { WhatsNewPanel } from "@/features/whats-new/components/whats-new-panel";
import { entry, feedOf, NOW } from "@/features/whats-new/fixtures";
import { fakeCore, renderWithQuery } from "@/test/render";
import { TourReleaseProvider } from "../release-context";
import { tourShowMe } from "./tour-show-me";

const project = { id: "p1", slug: "forge" } as ProjectListItem;

function panel(feed: ReturnType<typeof feedOf>, opts: { project?: ProjectListItem | null; release?: string | null } = {}) {
  fakeCore((call) => (call.path.startsWith("/me/whats-new") ? { body: feed } : undefined));
  renderWithQuery(
    <CurrentProjectProvider project={opts.project === undefined ? project : opts.project}>
      <TourReleaseProvider value={opts.release === undefined ? "0.4.0-dev.91" : opts.release}>
        <WhatsNewPanel open onClose={() => {}} failure={null} now={NOW} feed={feed} entryAction={tourShowMe} />
      </TourReleaseProvider>
    </CurrentProjectProvider>,
  );
}

describe("Show me on a What's new entry", () => {
  it("links an entry's tour to the page of the open project it runs on, with the step count", async () => {
    panel(feedOf([entry("e1", "new", "2026-10-07T08:00:00Z", { tour: { id: "release-what-changes", revision: 1 } })]));
    const link = await screen.findByTestId("whats-new-tour-link");
    expect(link).toHaveTextContent("Show me · 2 steps");
    expect(link).toHaveAttribute("href", "/projects/forge/releases/0.4.0-dev.91?tour=release-what-changes");
  });

  it("links a settings tour to the tab it runs on", async () => {
    panel(feedOf([entry("e1", "new", "2026-10-07T08:00:00Z", { tour: { id: "integrations", revision: 1 } })]));
    expect(await screen.findByTestId("whats-new-tour-link")).toHaveAttribute("href", "/projects/forge/settings?tab=integrations&tour=integrations");
  });

  it("offers nothing where no project is open", () => {
    panel(feedOf([entry("e1", "new", "2026-10-07T08:00:00Z", { tour: { id: "integrations", revision: 1 } })]), { project: null });
    expect(screen.queryByTestId("whats-new-tour-link")).toBeNull();
  });

  it("offers nothing for an entry no tour belongs to", () => {
    panel(feedOf([entry("e2", "improved", "2026-10-07T08:00:00Z")]));
    expect(screen.getByText("e2 title.")).toBeInTheDocument();
    expect(screen.queryByTestId("whats-new-tour-link")).toBeNull();
  });
});

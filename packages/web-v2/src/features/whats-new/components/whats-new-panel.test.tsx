import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { feedOf, releaseOf } from "../fixtures";
import { WhatsNewPanel } from "./whats-new-panel";

const open = (feed: ReturnType<typeof feedOf>) => renderWithQuery(<WhatsNewPanel open onClose={() => {}} failure={null} feed={feed} />);

describe("the What's new panel", () => {
  it("leads with the release, then its highlights, then its lines", () => {
    open(feedOf());
    expect(screen.getByTestId("whats-new-release")).toHaveTextContent("Release 0.4.0-dev.9");
    const highlights = screen.getByTestId("page-highlights");
    expect(highlights).toHaveTextContent("Every release has a page");
    const lines = within(screen.getByTestId("whats-new-changes")).getAllByTestId("whats-new-change");
    expect(lines.map((l) => l.textContent)).toEqual([expect.stringContaining("Releases read as pages."), expect.stringContaining("Dates show correctly.")]);
    expect(highlights.compareDocumentPosition(screen.getByTestId("whats-new-changes")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("plays a clip from the link made for the reader, which needs no session", () => {
    open(feedOf());
    expect(screen.getByTestId("release-media-clip")).toHaveAttribute("src", expect.stringContaining("/api/attachments/"));
  });

  it("says plainly when no release carries this build, naming the environment", () => {
    open(feedOf(null, "beta"));
    expect(screen.getByTestId("whats-new-none")).toHaveTextContent("This beta instance is running a build that is no release yet");
    expect(screen.queryByTestId("page-highlights")).toBeNull();
  });

  it("shows the lines of a release whose highlights were none", () => {
    open(feedOf(releaseOf({ highlights: { state: "none", why: "no criterion is proven on this build" } as never })));
    expect(screen.queryByTestId("page-highlights")).toBeNull();
    expect(screen.getAllByTestId("whats-new-change")).toHaveLength(2);
  });

  it("says the read failed instead of an empty release", () => {
    renderWithQuery(<WhatsNewPanel open onClose={() => {}} failure="failed" feed={undefined} />);
    expect(screen.getByText("What's new could not be read.")).toBeInTheDocument();
  });
});

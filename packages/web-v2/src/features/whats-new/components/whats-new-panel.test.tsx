import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { feedOf, releaseOf } from "../fixtures";
import { WhatsNewSheet } from "./whats-new-panel";

const open = (feed: ReturnType<typeof feedOf>) => renderWithQuery(<WhatsNewSheet open onClose={() => {}} failure={null} feed={feed} />);

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

  it("names the release and says in a few sentences what it brings, above its highlights (BC-14)", () => {
    open(feedOf());
    const lead = screen.getByTestId("whats-new-lead");
    expect(within(lead).getByTestId("whats-new-name")).toHaveTextContent("Readable releases");
    expect(within(lead).getByTestId("whats-new-summary")).toHaveTextContent("Every release now opens as a page you can read.");
    expect(lead.compareDocumentPosition(screen.getByTestId("page-highlights")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leads on the version alone where the release is not named yet", () => {
    open(feedOf(releaseOf({ name: null, summary: null })));
    expect(screen.queryByTestId("whats-new-name")).toBeNull();
    expect(screen.queryByTestId("whats-new-summary")).toBeNull();
    expect(screen.getByTestId("whats-new-release")).toHaveTextContent("Release 0.4.0-dev.9");
  });

  it("plays a highlight's clip inline, muted and with controls, from the link made for the reader (BC-3)", () => {
    open(feedOf());
    const clip = screen.getByTestId<HTMLVideoElement>("release-media-clip");
    expect(clip.tagName).toBe("VIDEO");
    expect(clip).toHaveAttribute("src", expect.stringContaining("/api/attachments/"));
    expect(clip.muted).toBe(true);
    expect(clip).toHaveAttribute("controls");
    expect(clip).toHaveAttribute("playsinline");
  });

  it("shows what there is to see: a highlight with no clip says nothing of the gap", () => {
    const release = releaseOf();
    if (release.highlights.state !== "drafted") throw new Error("fixture");
    const [h] = release.highlights.highlights;
    if (!h) throw new Error("fixture");
    const bare = { ...h, media: null, mediaGap: "QA kept no clip or picture as evidence of BC-1 on this build" };
    open(feedOf({ ...release, highlights: { ...release.highlights, highlights: [bare] } }));
    expect(screen.getByTestId("page-highlight")).toBeInTheDocument();
    expect(screen.queryByTestId("page-highlight-gap")).toBeNull();
    expect(screen.getByTestId("whats-new-panel")).not.toHaveTextContent("BC-1");
  });

  it("says plainly when no release carries this build", () => {
    open(feedOf(null, "beta"));
    expect(screen.getByTestId("whats-new-none")).toHaveTextContent("Nothing new");
    expect(screen.queryByTestId("page-highlights")).toBeNull();
  });

  it("shows the lines of a release whose highlights were none", () => {
    open(feedOf(releaseOf({ highlights: { state: "none", why: "no criterion is proven on this build" } as never })));
    expect(screen.queryByTestId("page-highlights")).toBeNull();
    expect(screen.getAllByTestId("whats-new-change")).toHaveLength(2);
  });

  it("says the read failed instead of an empty release", () => {
    renderWithQuery(<WhatsNewSheet open onClose={() => {}} failure="failed" feed={undefined} />);
    expect(screen.getByText("What's new could not be read.")).toBeInTheDocument();
  });
});

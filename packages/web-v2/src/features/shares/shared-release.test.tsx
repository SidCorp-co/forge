import { ReleasePageSnapshotSchema } from "@forge/contracts/release-page";
import { type ShareReleaseSnapshot, ShareReleaseSnapshotSchema } from "@forge/contracts/shares";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releasePage } from "@/test/release-page";
import { fakeCore, renderWithQuery } from "@/test/render";
import { SharedAnswer } from "./components/shared-answer";

// A release page shared by link (REQ-40 BC-11): the frozen user view opens at /s/<token>, read-only,
// drawn by the reader the app uses, its clip playing from the download link minted for this opening.

const TOKEN = `forge_share_${"r".repeat(43)}`;

function opened(): ShareReleaseSnapshot {
  const page = releasePage();
  if (page.highlights.state !== "drafted") throw new Error("fixture");
  const media = page.highlights.highlights[0]?.media;
  if (!media) throw new Error("fixture");
  media.url = "/api/uploads/download/ticket-xyz";
  const { view, header, highlights, requirements, improvements, fixes, withoutNotes, actionRequired, knownIssues, technical, can } = page;
  return ShareReleaseSnapshotSchema.parse({
    audience: "link",
    expiresAt: "2026-10-16T10:00:00.000Z",
    release: ReleasePageSnapshotSchema.parse({ view, projectId: "11111111-1111-4111-8111-111111111111", header, highlights, requirements, improvements, fixes, withoutNotes, actionRequired, knownIssues, technical, can: { ...can, share: false, export: false } }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("a shared release page", () => {
  it("opens through the open door and draws the release page, read-only", async () => {
    const calls = fakeCore((c) => (c.path === "/shares/open" ? { body: opened() } : undefined));
    const { container } = renderWithQuery(<SharedAnswer token={TOKEN} signedIn={false} />);
    expect(await screen.findByTestId("shared-release")).toBeTruthy();
    expect(calls).toEqual([{ method: "POST", path: "/shares/open", body: { token: TOKEN } }]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Release 0.4.0");
    expect(screen.getByText(/read-only snapshot/)).toBeTruthy();
    expect(screen.getByTestId("page-improvements")).toHaveTextContent("Releases read as pages.");
    expect(screen.getByTestId("page-known-issues")).toHaveTextContent("Falls short");
    // a reader may not be a member: no link into the project, and no share or export acts
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(screen.queryByTestId("release-page-actions")).toBeNull();
  });

  it("plays the clip from the opening's own download link, fetching nothing with a session", async () => {
    const real = fakeCore((c) => (c.path === "/shares/open" ? { body: opened() } : undefined));
    renderWithQuery(<SharedAnswer token={TOKEN} signedIn={false} />);
    const clip = await screen.findByTestId("release-media-clip");
    expect(clip).toHaveAttribute("src", "/api/uploads/download/ticket-xyz");
    expect(real.map((c) => c.path)).toEqual(["/shares/open"]);
  });

  it("still opens a frozen report document as before", async () => {
    fakeCore(() => ({
      body: { audience: "link", expiresAt: "2026-10-15T09:00:00.000Z", document: { templateId: "chat-answer", version: 1, params: {}, runs: [], blocks: [], narrative: { summary: "", risks: "", recommendations: "" }, title: "Q?", reply: "A." } },
    }));
    renderWithQuery(<SharedAnswer token={TOKEN} signedIn={false} />);
    expect(await screen.findByTestId("shared-reply")).toHaveTextContent("A.");
    expect(screen.queryByTestId("shared-release")).toBeNull();
  });
});

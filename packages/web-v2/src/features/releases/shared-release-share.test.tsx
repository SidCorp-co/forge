import { ReleasePageSnapshotSchema } from "@forge/contracts/release-page";
import { type ShareReleaseSnapshot, ShareReleaseSnapshotSchema } from "@forge/contracts/shares";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releasePage } from "@/test/release-page";
import { fakeCore, renderWithQuery } from "@/test/render";
import { SharedAnswer } from "@/features/shares";
import { SharedReleaseView } from "./components/shared-release";

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
    const { container } = renderWithQuery(<SharedAnswer token={TOKEN} signedIn={false} release={(r) => <SharedReleaseView snapshot={r} />} />);
    expect(await screen.findByTestId("shared-release")).toBeTruthy();
    expect(calls).toEqual([{ method: "POST", path: "/shares/open", body: { token: TOKEN } }]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("0.4.0 · Readable releases");
    expect(screen.getByText(/read-only snapshot/)).toBeTruthy();
    expect(screen.getByTestId("page-summary")).toHaveTextContent("opens as a page you can read in a minute");
    expect(screen.getByTestId("page-group-new")).toHaveTextContent("Releases read as pages");
    // the overview a share freezes counts what users do not see and lists no criterion (REQ-40 BC-15, BC-16)
    expect(screen.queryByTestId("page-known-issue")).toBeNull();
    expect(screen.getByTestId("page-internal-line")).toHaveTextContent("1 change has no note for users.");
    const row = screen.getAllByTestId("page-change")[0];
    if (!row) throw new Error("no change row");
    fireEvent.click(within(row).getAllByRole("button")[0]);
    expect(row).toHaveTextContent("Open any release and read what it brings, whole, in under a minute.");
    // a reader may not be a member: no link into the project (only the page's own anchors), and no share or export acts
    expect([...container.querySelectorAll("a")].filter((a) => !a.getAttribute("href")?.startsWith("#"))).toHaveLength(0);
    expect(screen.queryByTestId("page-row-technical")).toBeNull();
    expect(screen.queryByTestId("release-page-actions")).toBeNull();
  });

  it("plays the clip from the opening's own download link, fetching nothing with a session", async () => {
    const real = fakeCore((c) => (c.path === "/shares/open" ? { body: opened() } : undefined));
    renderWithQuery(<SharedAnswer token={TOKEN} signedIn={false} release={(r) => <SharedReleaseView snapshot={r} />} />);
    const clip = await screen.findByTestId("release-media-clip");
    expect(clip).toHaveAttribute("src", "/api/uploads/download/ticket-xyz");
    expect(real.map((c) => c.path)).toEqual(["/shares/open"]);
  });

  it("still opens a frozen report document as before", async () => {
    fakeCore(() => ({
      body: { audience: "link", expiresAt: "2026-10-15T09:00:00.000Z", document: { templateId: "chat-answer", version: 1, params: {}, runs: [], blocks: [], narrative: { summary: "", risks: "", recommendations: "" }, title: "Q?", reply: "A." } },
    }));
    renderWithQuery(<SharedAnswer token={TOKEN} signedIn={false} release={(r) => <SharedReleaseView snapshot={r} />} />);
    expect(await screen.findByTestId("shared-reply")).toHaveTextContent("A.");
    expect(screen.queryByTestId("shared-release")).toBeNull();
  });
});

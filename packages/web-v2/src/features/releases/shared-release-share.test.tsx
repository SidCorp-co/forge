import { ReleasePageSnapshotSchema } from "@forge/contracts/release-page";
import { type ShareReleaseSnapshot, ShareReleaseSnapshotSchema } from "@forge/contracts/shares";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releasePage } from "@/test/release-page";
import { fakeCore, renderWithQuery } from "@/test/render";
import { rawKeysOnFace } from "@/test/screen-face";
import { SharedAnswer } from "@/features/shares";
import { SharedReleaseView } from "./components/shared-release";

// A release page shared by link (REQ-40 BC-11): the frozen user view opens at /s/<token>, read-only,
// drawn by the report the app uses (ISS-1001).

const TOKEN = `forge_share_${"r".repeat(43)}`;

function opened(): ShareReleaseSnapshot {
  const page = releasePage();
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
    // the same report the app draws: what users see by screen, in the notes' words, and no key on its face (ISS-1001)
    expect(screen.getByTestId("page-screens")).toHaveTextContent("Releases read as pages");
    expect(screen.getByTestId("page-unseen")).toHaveTextContent("Changes 1");
    expect(screen.queryByTestId("page-known-issue")).toBeNull();
    expect(rawKeysOnFace(container)).toEqual([]);
    // a reader may not be a member: no link into the project (only the page's own anchors), and no share or export acts
    expect([...container.querySelectorAll("a")].filter((a) => !a.getAttribute("href")?.startsWith("#"))).toHaveLength(0);
    expect(screen.queryByTestId("page-row-technical")).toBeNull();
    expect(screen.queryByTestId("release-page-actions")).toBeNull();
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

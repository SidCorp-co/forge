// Share and export of a release page (BC-11): Markdown copied or saved, an .eml saved that decodes
// back to the page's words, and a share created for the release's version.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releasePage } from "@/test/release-page";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ReleasePageActions } from "./release-page-actions";

afterEach(() => vi.unstubAllGlobals());

function captureSaves() {
  const saved: Blob[] = [];
  const names: string[] = [];
  URL.createObjectURL = vi.fn((b: Blob) => {
    saved.push(b);
    return "blob:x";
  });
  URL.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
  });
  return { saved, names, click };
}

describe("exporting a release page", () => {
  it("copies the Markdown, made of the user sections with the clip as an absolute link", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithQuery(<ReleaseActions />);
    fireEvent.click(screen.getByTestId("release-page-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const md = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(md).toContain("# Release 0.4.0");
    expect(md).toContain(`(${window.location.origin}/api/attachments/00000000-0000-4000-8000-000000000001/download)`);
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("saves the Markdown as release-<version>.md", async () => {
    const { saved, names } = captureSaves();
    renderWithQuery(<ReleaseActions />);
    fireEvent.click(screen.getByTestId("release-page-markdown"));
    expect(names).toEqual(["release-0.4.0.md"]);
    expect(await saved[0]?.text()).toContain("## Known issues");
  });

  it("saves an email as an .eml whose bodies decode to the page's words", async () => {
    const { saved, names } = captureSaves();
    renderWithQuery(<ReleaseActions />);
    fireEvent.click(screen.getByTestId("release-page-email"));
    expect(names).toEqual(["release-0.4.0.eml"]);
    const eml = (await saved[0]?.text()) ?? "";
    expect(eml).toContain("X-Unsent: 1");
    expect(eml).toContain("multipart/alternative");
    const plainPart = eml.split(/--forge-release-\w+\r\n/)[1] ?? "";
    const plain = plainPart.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") ?? "";
    expect(atob(plain)).toContain("Releases read as pages.");
  });

  it("offers neither share nor export where the page says the viewer may do neither", () => {
    renderWithQuery(<ReleasePageActions projectId="p1" page={releasePage({ can: { share: false, export: false, approve: false } })} />);
    expect(screen.queryByTestId("release-page-actions")).toBeNull();
  });

  it("offers export without share to a viewer who may not share", () => {
    renderWithQuery(<ReleasePageActions projectId="p1" page={releasePage({ can: { share: false, export: true, approve: false } })} />);
    expect(screen.queryByTestId("release-page-share")).toBeNull();
    expect(screen.getByTestId("release-page-markdown")).toBeTruthy();
  });
});

describe("sharing a release page", () => {
  it("creates a share whose subject is the release's version", async () => {
    const calls = fakeCore((c) => {
      if (c.path === "/projects/p1/shares/audiences")
        return { body: { audiences: [{ audience: "members", refusal: null }, { audience: "link", refusal: null }] } };
      if (c.method === "POST" && c.path === "/projects/p1/shares")
        return {
          status: 201,
          body: {
            share: { id: "s1", projectId: "p1", audience: "members", subjectKind: "release", title: "Release 0.4.0", createdBy: "u1", createdAt: "2026-10-09T10:00:00.000Z", expiresAt: "2026-10-16T10:00:00.000Z", revokedAt: null, revokedBy: null, viewCount: 0, lastViewedAt: null },
            url: "https://forge.example/s/forge_share_x",
          },
        };
      return undefined;
    });
    renderWithQuery(<ReleasePageActions projectId="p1" page={releasePage()} />);
    fireEvent.click(screen.getByTestId("release-page-share"));
    expect(await screen.findByText("Share this release page")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: /create/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/projects/p1/shares")).toBe(true));
    const post = calls.find((c) => c.method === "POST" && c.path === "/projects/p1/shares");
    expect(post?.body).toMatchObject({ subjectKind: "release", subjectId: "0.4.0", audience: "members" });
  });
});

function ReleaseActions() {
  return <ReleasePageActions projectId="p1" page={releasePage()} />;
}

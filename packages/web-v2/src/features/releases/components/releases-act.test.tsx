// Releases shows on its face what a person acts on (REQ-11 BC-18, BC-19): every row — the list's, the
// coming-next table's and the train's — leads with its title or name, and a requirement key sits in
// a tooltip, never in a column of its own or a facts line.
// @direct-test-of packages/web-v2/src/design/patterns/grouped-list.tsx

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { faceWords, rawKeysOnFace } from "@/test/screen-face";
import { P, releaseSeed } from "@/test/vi-chrome-rel-wf";
import { Seeded } from "@/test/vi-chrome-requirements";
import { ReleasesScreen } from "./releases-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const releases = () => render(<Seeded data={releaseSeed()}><ReleasesScreen projectId={P} slug="hop" /></Seeded>);

describe("Releases leads with names, never keys (REQ-11 BC-19)", () => {
  it("draws no requirement key, issue key or sha as text on its face", () => {
    const { container } = releases();
    expect(rawKeysOnFace(container)).toEqual([]);
  });

  it("has no Key column: the list's header starts at the title, and each row's first text is its title", () => {
    releases();
    const list = screen.getByTestId("grouped-list");
    expect(within(list).getByTestId("list-header").textContent).not.toMatch(/^Key/);
    const row = within(list).getAllByTestId("list-row")[0];
    expect(row.textContent).toMatch(/^Release 0\.1\.0/);
    expect(row.querySelector("[title='0.1.0']")?.textContent).toBe("Release 0.1.0");
  });

  it("keeps a release's requirement keys in the tooltip of its count", () => {
    releases();
    const count = screen.getByTestId("release-requirements");
    expect(count.textContent).toBe("Requirements 1");
    expect(count.getAttribute("title")).toBe("REQ-1");
  });

  it("leads coming next's rows with the requirement's title, its link, the key its tooltip", () => {
    releases();
    const row = screen.getByTestId("coming-next-requirement");
    const link = within(row).getByRole("link");
    expect(link.textContent).toBe("Muc");
    expect(link.getAttribute("title")).toBe("REQ-1");
    expect(within(screen.getByTestId("coming-next-header")).queryByText("Key")).toBeNull();
  });

  it("stays within the first view's budget of 300 words (BC-21)", () => {
    const { container } = releases();
    expect(faceWords(container)).toBeLessThanOrEqual(300);
  });
});

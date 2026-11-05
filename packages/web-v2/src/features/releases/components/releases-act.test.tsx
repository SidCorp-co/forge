// The Releases list shows on its face what a person acts on (REQ-11 BC-18, BC-19; ISS-1001): each
// row leads with its version and name, carries one proof bar and the short tags of what needs
// attention, and only a release waiting on the reader offers its one act. No key, sha or second
// table repeating the draft (the retired coming-next) is drawn.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { faceWords, rawKeysOnFace } from "@/test/screen-face";
import { P, releaseSeed } from "@/test/vi-chrome-rel-wf";
import { Seeded } from "@/test/vi-chrome-requirements";
import { ReleasesScreen } from "./releases-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const releases = () => render(<Seeded data={releaseSeed()}><ReleasesScreen projectId={P} slug="hop" /></Seeded>);

describe("the Releases list's face (REQ-11 BC-19, ISS-1001)", () => {
  it("draws no requirement key, issue key or sha as text on its face", () => {
    const { container } = releases();
    expect(rawKeysOnFace(container)).toEqual([]);
  });

  it("groups the draft waiting on the reader first and the release in production last", () => {
    releases();
    const groups = screen.getAllByTestId("release-group").map((g) => [g.dataset.group, within(g).queryAllByTestId("list-row").map((r) => r.dataset.key)]);
    expect(groups).toEqual([
      ["you", ["0.1.0"]],
      ["going", []],
      ["production", ["0.0.9"]],
    ]);
  });

  it("leads each row with its version, gives the draft one proof bar, and the one act only where it waits on the reader", () => {
    releases();
    const [draft, shipped] = screen.getAllByTestId("list-row");
    expect(draft.textContent).toMatch(/^0\.1\.0/);
    expect(within(draft).getAllByTestId("release-proof")).toHaveLength(1);
    expect(within(draft).getByTestId("release-proof")).toHaveAttribute("data-proven", "1");
    expect(within(draft).getByTestId("release-proof")).toHaveAttribute("data-total", "2");
    expect(within(draft).getByTestId("release-tags")).toHaveTextContent("1 unproven");
    expect(within(draft).getAllByTestId("release-row-act")).toHaveLength(1);
    expect(within(shipped).queryByTestId("release-row-act")).toBeNull();
  });

  it("draws no second table repeating the draft: coming next is retired", () => {
    const { container } = releases();
    expect(container.querySelector("[data-testid^=coming-next]")).toBeNull();
    expect(container.querySelector("[data-testid=release-train]")).toBeNull();
  });

  it("stays within the first view's budget of 300 words (BC-21)", () => {
    const { container } = releases();
    expect(faceWords(container)).toBeLessThanOrEqual(300);
  });
});

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

  // REQ-43 r3 BC-14 (owner, 2026-11-10): the page opens on its overview, above the list, and each
  // state's count there is the list's own (L-57)
  it("opens on its overview band above the list, its state counts summing to the list's groups", () => {
    releases();
    const band = screen.getByTestId("releases-band");
    const list = screen.getByTestId("release-list");
    expect(band.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const flow = within(band).getAllByTestId("coverage-part-count").map((c) => Number(c.textContent));
    const groups = within(list).getAllByTestId("group-count").map((c) => Number(c.textContent));
    expect(flow.reduce((a, b) => a + b, 0)).toBe(groups.reduce((a, b) => a + b, 0));
    expect(within(band).getByTestId("releases-band-chart")).toBeInTheDocument();
  });

  it("draws no second table repeating the draft: coming next is retired", () => {
    const { container } = releases();
    expect(container.querySelector("[data-testid^=coming-next]")).toBeNull();
    expect(container.querySelector("[data-testid=release-train]")).toBeNull();
  });

  // the owner's review of forge-dev, 2026-11-09: "In production 564" where the project releases to dev (ISS-1179 item 9)
  it("names the shipped and going groups by the environment the project releases to", () => {
    const [list, ...rest] = releaseSeed();
    const [key, body] = list as [unknown[], Record<string, unknown>];
    render(
      <Seeded data={[[key, { ...body, production: { ok: true, name: "dev", url: null, serving: null } }], ...rest] as never}>
        <ReleasesScreen projectId={P} slug="hop" />
      </Seeded>,
    );
    const label = (id: string) => screen.getAllByTestId("release-group").find((g) => g.dataset.group === id) as HTMLElement;
    expect(label("production")).toHaveTextContent("On dev");
    expect(label("going")).toHaveTextContent("Going to dev");
    expect(screen.getByTestId("release-list")).not.toHaveTextContent("production");
  });

  it("stays within the first view's budget of 300 words (BC-21)", () => {
    const { container } = releases();
    expect(faceWords(container)).toBeLessThanOrEqual(300);
  });
});

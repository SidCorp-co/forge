// The issue page shows on its face what a person acts on (REQ-11 BC-18, BC-19): its title heads it
// with the key as the tooltip, and the rail names the requirement by its title, counts the criteria it
// traces and the reports routed to it — the keys, codes and commit sit in tooltips.

import type { QueryKey } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { faceWords, rawKeysOnFace } from "@/test/screen-face";
import { detailQueries } from "@/test/vi-chrome-issues";
import { Seeded } from "@/test/vi-chrome-requirements";
import { IssueDetailScreen } from "./issue-detail-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

/** The fixture's reads, the issue titled in words of its own: the fixture's title carries its key, which would read as a key on the face. */
const seed = (): [QueryKey, unknown][] =>
  detailQueries().map(([key, value]) => (key[0] === "issue" && key[1] === "i1" && key.length <= 3 && (value as { displayId?: string }).displayId ? [key, { ...(value as object), title: "Totals drift on export" }] : [key, value]));

/** The page outside a shell: its header, which a shell portals into the top bar, draws in place. jsdom
 *  lays nothing out, so the rail stands where a narrow screen puts it, behind the Facts disclosure,
 *  which is opened so the rail is on the face too. */
const page = () => {
  const r = render(
    <Seeded data={seed()}>
      <IssueDetailScreen projectId="p1" slug="hop" id="i1" />
    </Seeded>,
  );
  fireEvent.click(screen.getByTestId("rail-facts-toggle"));
  return r;
};

describe("the issue page leads with names, never keys (REQ-11 BC-19)", () => {
  it("draws no issue, requirement, feedback or criterion key, nor a sha, as text on its face", () => {
    const { container } = page();
    expect(rawKeysOnFace(container)).toEqual([]);
  });

  it("heads the page with the issue's title, its key the tooltip", () => {
    page();
    const title = screen.getAllByTestId("issue-title")[0];
    expect(title.getAttribute("title")).toBe("ISS-1");
    expect(title.textContent?.trim()).not.toBe("");
  });

  it("names the requirement by its title, counts the criteria it traces, and labels each report without its key", () => {
    page();
    const req = within(screen.getByTestId("issue-requirement")).getByRole("link");
    expect(req.getAttribute("title")).toBe("REQ-1");
    expect(req.textContent).toBe("Dang nhap");
    const traces = screen.getByTestId("rail-traces");
    expect(traces.textContent).toBe("Criteria 1");
    expect(traces.getAttribute("title")).toBe("BC-1");
    const report = within(screen.getByTestId("rail-feedback")).getByRole("link");
    expect(report.textContent).toBe("Report 1");
    expect(report.getAttribute("title")).toBe("FB-3");
  });

  it("stays within the first view's budget of 300 words (BC-21)", () => {
    const { container } = page();
    expect(faceWords(container)).toBeLessThanOrEqual(300);
  });
});

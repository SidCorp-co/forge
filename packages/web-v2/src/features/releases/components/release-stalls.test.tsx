// A release page reports what stalled its delivery by cause (REQ-67 BC-7): one line counting each
// cause, each count opening the stalls behind it with the item and the question each raised, never a
// raw key. A release with none says so in two words; a shared page, which carries no stalls, draws none.
//
// @direct-test-of packages/web-v2/src/features/releases/components/release-stalls.tsx
// @direct-test-of packages/web-v2/src/features/releases/components/release-reader.tsx

import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReleaseStalls } from "@forge/contracts/stalls";
import { releasePage } from "@/test/release-page";
import { renderWithQuery } from "@/test/render";
import { ReleaseReader } from "./release-reader";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const STALLS: ReleaseStalls = {
  counts: { unclear_item: 1, defect: 1, waiting_on_person: 0 },
  stalls: [
    {
      cause: "unclear_item",
      item: { kind: "requirement", key: "REQ-67", title: "Clear requirements" },
      issue: { key: "ISS-696", title: "Stalls by cause" },
      question: "Is a reopen a stall?",
      startedAt: "2026-11-01T10:00:00.000Z",
      endedAt: null,
    },
    {
      cause: "defect",
      item: null,
      issue: { key: "ISS-700", title: "Export currency" },
      question: null,
      startedAt: "2026-11-01T11:00:00.000Z",
      endedAt: "2026-11-02T11:00:00.000Z",
    },
  ],
};

/** The words a reader sees, counted text node by text node so adjacent elements never run together. */
function words(el: HTMLElement): number {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n = 0;
  for (let node = walk.nextNode(); node; node = walk.nextNode()) n += (node.textContent ?? "").split(/\s+/).filter(Boolean).length;
  return n;
}

describe("the stalls section", () => {
  it("counts each cause in one line and opens a cause's stalls on demand, with no raw key", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ stalls: STALLS })} authed />);
    const section = screen.getByTestId("page-stalls");
    expect(within(section).getByTestId("page-stalls-unclear_item").textContent).toBe("Unclear item 1");
    expect(within(section).getByTestId("page-stalls-defect").textContent).toBe("Defect 1");
    expect(within(section).queryByTestId("page-stalls-waiting_on_person")).toBeNull();
    expect(within(section).queryByTestId("page-stalls-list")).toBeNull();

    fireEvent.click(within(section).getByTestId("page-stalls-unclear_item"));
    const [stall] = within(section).getAllByTestId("page-stall");
    expect(stall?.textContent).toContain("Clear requirements");
    expect(stall?.textContent).toContain("Is a reopen a stall?");
    expect(stall?.textContent).toContain("Open");
    expect(section.textContent).not.toMatch(/REQ-\d|ISS-\d/);

    fireEvent.click(within(section).getByTestId("page-stalls-defect"));
    expect(within(section).getAllByTestId("page-stall").map((s) => s.textContent)).toEqual(["Export currency"]);
  });

  it("says a release nothing stalled in one short line", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} authed />);
    expect(screen.getByTestId("page-stalls-none").textContent).toBe("No stalls");
    expect(screen.queryByTestId("page-stalls")).toBeNull();
  });

  it("draws nothing on a shared page, which carries no stalls", () => {
    renderWithQuery(<ReleaseReader page={releasePage({ stalls: null })} authed={false} />);
    expect(screen.queryByTestId("page-stalls")).toBeNull();
    expect(screen.queryByTestId("page-stalls-none")).toBeNull();
  });

  it("adds at most a few visible words to the page", () => {
    const before = renderWithQuery(<ReleaseReader page={releasePage({ stalls: null })} authed />);
    const without = words(before.container);
    before.unmount();
    const none = renderWithQuery(<ReleaseReader page={releasePage()} authed />);
    const withNone = words(none.container);
    none.unmount();
    const some = renderWithQuery(<ReleaseReader page={releasePage({ stalls: STALLS })} authed />);
    const withSome = words(some.container);
    console.info(`release page visible words: ${without} without the section, ${withNone} with none, ${withSome} with two`);
    expect(withNone - without).toBe(2);
    expect(withSome - without).toBeLessThanOrEqual(6);
  });
});

// @vitest-environment jsdom
//
// The drawer closes on Escape, except where something inside it already took
// that key to close itself: a menu dismissed inside the Ask-agent drawer must
// not take the conversation, and its draft, with it (ISS-1146).

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlideOver } from "./slide-over";

expect.extend(matchers);
afterEach(cleanup);

function renderDrawer(onInnerKeyDown?: (e: React.KeyboardEvent) => void) {
  const onClose = vi.fn();
  render(
    <SlideOver open onClose={onClose} title="Drawer">
      <button type="button" onKeyDown={onInnerKeyDown}>
        inner
      </button>
    </SlideOver>,
  );
  return { onClose, inner: screen.getByRole("button", { name: "inner" }) };
}

describe("SlideOver and Escape", () => {
  it("closes on an Escape nothing inside it took", () => {
    const { onClose, inner } = renderDrawer();
    fireEvent.keyDown(inner, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open when a control inside it claimed the Escape", () => {
    const { onClose, inner } = renderDrawer((e) => {
      if (e.key === "Escape") e.preventDefault();
    });
    fireEvent.keyDown(inner, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close on another key", () => {
    const { onClose, inner } = renderDrawer();
    fireEvent.keyDown(inner, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SlideOver and the page's stacking contexts", () => {
  // ISS-1327: rendered inside the sticky issue rail, the fixed drawer was painted in the rail's
  // stacking context, under the sticky issue header. A drawer on `body` is above both.
  it("renders on document.body, not inside the element that rendered it", () => {
    render(
      <div data-testid="sticky-rail" style={{ position: "sticky", top: 0 }}>
        <SlideOver open onClose={() => {}} title="Mark this work merged">
          <p>body</p>
        </SlideOver>
      </div>,
    );
    const dialog = screen.getByRole("dialog");
    expect(screen.getByTestId("sticky-rail")).not.toContainElement(dialog);
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });
});

// ISS-1421 r18 — a long title pushed Close off a 390 screen; jsdom does no layout, so this pins the
// property the browser measurement (in the issue's evidence) rested on.
describe("SlideOver's header with a title wider than the drawer", () => {
  it("lets the title shrink and keeps Close its own size", () => {
    render(
      <SlideOver open onClose={() => {}} title={"j75 Coolify production eu-west primary box number one again"}>
        <p>body</p>
      </SlideOver>,
    );
    const title = screen.getByTestId("slide-over-title");
    expect(title.className).toMatch(/\bmin-w-0\b/);
    expect(title.className).toMatch(/\bflex-1\b/);
    expect(screen.getByRole("button", { name: "Close" }).className).toMatch(/\bshrink-0\b/);
  });
});


describe("SlideOver stacked over another", () => {
  // ISS-1339 r3: a confirmation is itself a slide-over, and one Escape closed it and the drawer
  // under it together, taking an unsaved edit the confirmation was asking about.
  it("answers Escape on the topmost only", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <SlideOver open onClose={outer} title="Drawer">
        <SlideOver open onClose={inner} title="Confirm">
          <button type="button">keep</button>
        </SlideOver>
      </SlideOver>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "keep" }), { key: "Escape" });
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it("answers Escape on the one beneath once the one above has closed", () => {
    const outer = vi.fn();
    const { rerender } = render(
      <SlideOver open onClose={outer} title="Drawer">
        <button type="button">under</button>
        <SlideOver open onClose={() => {}} title="Confirm">
          <p>above</p>
        </SlideOver>
      </SlideOver>,
    );
    rerender(
      <SlideOver open onClose={outer} title="Drawer">
        <button type="button">under</button>
        <SlideOver open={false} onClose={() => {}} title="Confirm">
          <p>above</p>
        </SlideOver>
      </SlideOver>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "under" }), { key: "Escape" });
    expect(outer).toHaveBeenCalledOnce();
  });
});

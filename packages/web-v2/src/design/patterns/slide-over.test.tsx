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

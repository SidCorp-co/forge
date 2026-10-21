// @vitest-environment jsdom
//
// ISS-1229 r32, judge-90: with the keyboard up at 390x480 about 50 px of a room's conversation showed.
// While the message box has focus on a phone the room marks the document, and the frame's bars and the
// screen's heading step aside under the mark. jsdom applies no media query, so what is held here is the
// mark's life and the rule that reads it; the heights are measured on a rendered page.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STEPS_ASIDE, useComposingMark, useMessageBoxFocus } from "./composing";
import { ScopeNotice } from "./components/scope-notice";

expect.extend(matchers);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const marked = () => document.documentElement.dataset.composing !== undefined;

function Room() {
  const box = useMessageBoxFocus<HTMLDivElement>();
  useComposingMark(box.focused);
  return (
    <div>
      <button type="button">In the thread</button>
      <div ref={box.ref}>
        <textarea aria-label="Message" />
        <button type="button" aria-label="Send message" />
      </div>
    </div>
  );
}

describe("the mark a focused message box puts on the document", () => {
  it("stands while the box has focus and goes once focus leaves the box", () => {
    render(<Room />);
    const message = screen.getByLabelText("Message");
    fireEvent.focusIn(message);
    expect(marked()).toBe(true);
    fireEvent.focusOut(message, { relatedTarget: screen.getByText("In the thread") });
    expect(marked()).toBe(false);
  });

  it("holds through a press on Send until that press lands as a click", () => {
    render(<Room />);
    const message = screen.getByLabelText("Message");
    const send = screen.getByLabelText("Send message");
    fireEvent.focusIn(message);
    fireEvent.focusOut(message, { relatedTarget: send });
    expect(marked()).toBe(true);
    fireEvent.click(send);
    expect(marked()).toBe(false);
  });

  it("lets go of a press that never becomes a click", () => {
    vi.useFakeTimers();
    render(<Room />);
    const message = screen.getByLabelText("Message");
    fireEvent.focusIn(message);
    fireEvent.focusOut(message, { relatedTarget: screen.getByLabelText("Send message") });
    expect(marked()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(marked()).toBe(false);
  });

  it("goes with the room that set it", () => {
    const { unmount } = render(<Room />);
    fireEvent.focusIn(screen.getByLabelText("Message"));
    unmount();
    expect(marked()).toBe(false);
  });
});

describe("what steps aside under the mark", () => {
  it("is hidden below md, with main's tab-bar clearance given up", () => {
    const css = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf8");
    const rule = css.slice(css.indexOf("@media (max-width: 767.98px) {\n  html[data-composing]"));
    expect(rule).toMatch(/html\[data-composing\] \[data-steps-aside="composing"\] \{ display: none; \}/);
    expect(rule).toMatch(/html\[data-composing\] \[data-frame-main\] \{ padding-bottom: 0; \}/);
    expect(STEPS_ASIDE).toEqual({ "data-steps-aside": "composing" });
  });
});

describe("the About panel while the box has focus", () => {
  const room = { scopeProjects: [{ id: "p1", name: "Desk", slug: "desk" }] };

  it("shows folded to its one line", () => {
    render(<ScopeNotice room={room} folded />);
    expect(screen.getByRole("button", { name: /About Desk/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("opens on a press that lands on the folded line", () => {
    const { rerender } = render(<ScopeNotice room={room} folded />);
    const line = screen.getByRole("button", { name: /About Desk/ });
    fireEvent.pointerDown(line);
    rerender(<ScopeNotice room={room} folded={false} />);
    fireEvent.click(line);
    expect(line).toHaveAttribute("aria-expanded", "true");
  });
});

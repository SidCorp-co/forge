// @vitest-environment jsdom
//
// ISS-1078, consult F6 — following a turn that grows without the thread growing.
//
// Every earlier caller of this hook added ITEMS: a new turn, a new message, a
// new row. A streaming conversation turn does not. It is one entry that gets
// longer, so `itemCount` stays put and `live` is a boolean that was already
// true — and a reader pinned to the bottom followed the first frame and then
// watched the text run off the end of the viewport.
//
// The near-bottom guard is the other half and is asserted here too: somebody
// reading history is never dragged down, which is the property that made this
// hook conditional in the first place (ISS-728 AC3).

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStickToBottom } from "./use-stick-to-bottom";

afterEach(cleanup);

const scrolls: Array<ScrollIntoViewOptions | undefined> = [];

beforeEach(() => {
  scrolls.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, opts?: unknown) {
    scrolls.push(opts as ScrollIntoViewOptions | undefined);
  });
});

function Harness(props: { itemCount: number; live: boolean; streamedChars: number }) {
  const { scrollRef, bottomRef, onScroll } = useStickToBottom({
    conversationKey: "c1",
    ready: true,
    ...props,
  });
  return (
    <div ref={scrollRef} onScroll={onScroll} data-testid="scroller">
      <div ref={bottomRef} />
    </div>
  );
}

/** Put the container where a reader scrolled back into history would leave it. */
function scrollIntoHistory(el: HTMLElement, onScroll: () => void) {
  Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
  el.scrollTop = 0;
  onScroll();
}

describe("a thread following a turn that is still being written", () => {
  it("follows the text as it grows, with no new item to show for it", () => {
    const { rerender } = render(<Harness itemCount={3} live streamedChars={10} />);
    const before = scrolls.length;

    act(() => {
      rerender(<Harness itemCount={3} live streamedChars={48} />);
    });

    expect(scrolls.length).toBeGreaterThan(before);
    expect(scrolls.at(-1)).toMatchObject({ behavior: "smooth", block: "end" });
  });

  // cm:guard the growth dependency must not defeat the near-bottom guard: a reader who scrolled up
  // to read what was said earlier is the one person a streaming turn must not move, and this hook's
  // whole reason for being conditional is that turning it unconditional makes history unreadable.
  it("does not drag a reader who scrolled back into history", () => {
    const view = render(<Harness itemCount={3} live streamedChars={10} />);
    const el = view.getByTestId("scroller");
    scrollIntoHistory(el, () => el.dispatchEvent(new Event("scroll", { bubbles: true })));
    const before = scrolls.length;

    act(() => {
      view.rerender(<Harness itemCount={3} live streamedChars={48} />);
    });

    expect(scrolls.length).toBe(before);
  });

  it("still follows a new item, which is what it always did", () => {
    const { rerender } = render(<Harness itemCount={3} live={false} streamedChars={0} />);
    const before = scrolls.length;

    act(() => {
      rerender(<Harness itemCount={4} live={false} streamedChars={0} />);
    });

    expect(scrolls.length).toBeGreaterThan(before);
  });
});

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

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem, RenderBlock } from "../types";
import { NewOutput } from "./new-output";
import { tailOutputSize, useStickToBottom } from "./use-stick-to-bottom";

afterEach(cleanup);

const scrolls: Array<ScrollIntoViewOptions | undefined> = [];

beforeEach(() => {
  scrolls.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, opts?: unknown) {
    scrolls.push(opts as ScrollIntoViewOptions | undefined);
  });
});

function Harness(props: {
  itemCount: number;
  live: boolean;
  streaming?: boolean;
  streamedChars: number;
  conversationKey?: string;
}) {
  const { scrollRef, bottomRef, onScroll, newOutput, toBottom } = useStickToBottom({
    conversationKey: props.conversationKey ?? "c1",
    ready: true,
    ...props,
  });
  // cm:guard the harness draws the PILL, so criterion 28's assertions are about the affordance a
  // reader actually gets rather than about a boolean: the whole behaviour is "told there is new
  // output, and taken to it when they ask", and only the two together are worth anything.
  return (
    <div ref={scrollRef} onScroll={onScroll} data-testid="scroller">
      {newOutput && <NewOutput onGo={toBottom} />}
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
    const { rerender } = render(<Harness itemCount={3} live streaming streamedChars={10} />);
    const before = scrolls.length;

    act(() => {
      rerender(<Harness itemCount={3} live streaming streamedChars={48} />);
    });

    expect(scrolls.length).toBeGreaterThan(before);
    expect(scrolls.at(-1)).toEqual({ block: "end" });
  });

  // cm:guard a stream step asks for NO animation, and this assertion is the whole of what jsdom can
  // hold of the reason. A smooth scroll animates through every position on the way down and each
  // one fires `onScroll`; one reading more than 80px short sets `atBottomRef` false with nobody
  // having touched the page, and a turn that keeps growing moves the animation's target out from
  // under it, so the recovery never comes and the reader is dropped mid-turn. The feedback itself
  // is not reproducible here — `scrollIntoView` is a mock and jsdom animates nothing — so what goes
  // red is the request: this line fails the moment the stream path asks for `behavior: "smooth"`
  // again. The property it stands in for needs a real browser: start pinned, append a card taller
  // than the threshold, then append text every 120ms during the scroll, and assert the viewport is
  // still at the latest content once it settles (ISS-1078 review F6, whole-set consult).
  it("asks for no animation while a turn is arriving, and keeps one outside a turn", () => {
    const { rerender } = render(<Harness itemCount={3} live streaming streamedChars={10} />);

    let before = scrolls.length;
    act(() => {
      rerender(<Harness itemCount={3} live streaming streamedChars={48} />);
    });
    expect(scrolls.length).toBeGreaterThan(before);
    expect(scrolls.at(-1)).toEqual({ block: "end" });

    before = scrolls.length;
    act(() => {
      rerender(<Harness itemCount={4} live={false} streamedChars={48} />);
    });
    expect(scrolls.length).toBeGreaterThan(before);
    expect(scrolls.at(-1)).toEqual({ behavior: "smooth", block: "end" });
  });

  // cm:guard the ROW a reader queues mid-turn, which is the sequence the first version of this fix
  // still animated: the composer takes a follow-up while the reply streams (`queueWhileBusy`), and
  // that moves `itemCount` with the stream content untouched. Branching on which dependency moved
  // put a smooth animation in the middle of a stream — one is enough, because its own scroll events
  // set the guard false and every frame after it returns at the guard instead of re-affirming it,
  // so following never comes back for the rest of the turn. This is red the moment the branch goes
  // back to reading the changed dependency rather than whether a turn is arriving.
  it("does not animate a row queued while the reply is still streaming", () => {
    const { rerender } = render(<Harness itemCount={3} live streaming streamedChars={48} />);
    // cm:guard the COUNT is asserted before the options, in this case and the one below, because
    // the mount already recorded a `{block:"end"}` call: reading only `scrolls.at(-1)` passes
    // whether the rerender scrolled or not, so a hook that stopped following rows mid-stream
    // altogether — the opposite regression — would clear it (whole-set consult round 3).
    const before = scrolls.length;

    act(() => {
      rerender(<Harness itemCount={4} live streaming streamedChars={48} />);
    });

    expect(scrolls.length).toBeGreaterThan(before);
    expect(scrolls.at(-1)).toEqual({ block: "end" });
  });

  // cm:guard the watcher, who has no send of their own in flight: `live` is false for them for the
  // whole turn, so a hook reading `live` as "a turn is arriving" would animate every row and every
  // frame they see. `streaming` is what a second browser in the room has (criterion 6).
  it("does not animate for a second person watching, whose own send is not in flight", () => {
    const { rerender } = render(
      <Harness itemCount={3} live={false} streaming streamedChars={10} />,
    );
    const before = scrolls.length;

    act(() => {
      rerender(<Harness itemCount={3} live={false} streaming streamedChars={48} />);
    });

    expect(scrolls.length).toBeGreaterThan(before);
    expect(scrolls.at(-1)).toEqual({ block: "end" });
  });

  // cm:guard the growth dependency must not defeat the near-bottom guard: a reader who scrolled up
  // to read what was said earlier is the one person a streaming turn must not move, and this hook's
  // whole reason for being conditional is that turning it unconditional makes history unreadable.
  it("does not drag a reader who scrolled back into history", () => {
    const view = render(<Harness itemCount={3} live streaming streamedChars={10} />);
    const el = view.getByTestId("scroller");
    scrollIntoHistory(el, () => el.dispatchEvent(new Event("scroll", { bubbles: true })));
    const before = scrolls.length;

    act(() => {
      view.rerender(<Harness itemCount={3} live streaming streamedChars={48} />);
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

// ISS-1083 criterion 28 — the other half of the rule above. ISS-1078 built "a reader who has
// scrolled up is not moved" and shipped "and is told there is new output" as silence: a person who
// scrolled up to re-read a tool result while an answer streamed had no way to know the answer had
// finished except to scroll back down and look.
describe("telling a reader there is output they cannot see", () => {
  /** Scroll back into history, as a reader does. */
  const intoHistory = (el: HTMLElement) =>
    scrollIntoHistory(el, () => el.dispatchEvent(new Event("scroll", { bubbles: true })));

  /** Put the container back at the bottom, as a reader does. */
  const toTheBottom = (el: HTMLElement) => {
    Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
    el.scrollTop = 1500;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  };

  it("says nothing to a reader who is already at the bottom", () => {
    const { rerender } = render(<Harness itemCount={3} live streaming streamedChars={10} />);
    act(() => {
      rerender(<Harness itemCount={3} live streaming streamedChars={48} />);
    });
    expect(screen.queryByTestId("new-output")).toBeNull();
  });

  // cm:guard the two halves asserted TOGETHER, because either alone is a defect: the reader is told,
  // and the reader is not moved. A version that told them by scrolling them there would pass the
  // first assertion and fail the second, and that is the behaviour ISS-728 made this hook
  // conditional to prevent.
  it("tells a reader in history that output has arrived, without moving them", () => {
    const view = render(<Harness itemCount={3} live streaming streamedChars={10} />);
    intoHistory(view.getByTestId("scroller"));
    const before = scrolls.length;

    act(() => {
      view.rerender(<Harness itemCount={3} live streaming streamedChars={48} />);
    });

    expect(screen.queryByTestId("new-output")).not.toBeNull();
    expect(scrolls.length).toBe(before);
  });

  it("says nothing until something has actually arrived", () => {
    const view = render(<Harness itemCount={3} live={false} streamedChars={0} />);
    intoHistory(view.getByTestId("scroller"));
    // Scrolling up is not news. Nothing has been said since they left.
    expect(screen.queryByTestId("new-output")).toBeNull();
  });

  it("takes the reader to it when they ask, and stops saying it", () => {
    const view = render(<Harness itemCount={3} live streaming streamedChars={10} />);
    const el = view.getByTestId("scroller");
    intoHistory(el);
    act(() => {
      view.rerender(<Harness itemCount={3} live streaming streamedChars={48} />);
    });
    const before = scrolls.length;

    act(() => {
      fireEvent.click(screen.getByTestId("new-output"));
    });

    expect(scrolls.length).toBeGreaterThan(before);
    // cm:guard INSTANT, for the reason the growth effect gives: a smooth scroll fires `onScroll` at
    // every position on the way down, and one reading short of the threshold drops the reader
    // mid-turn. This click is most likely to happen while a turn is streaming underneath it.
    expect(scrolls.at(-1)).toEqual({ block: "end" });
    expect(screen.queryByTestId("new-output")).toBeNull();
  });

  // cm:guard and the pill follows a reader who takes themselves back rather than only one who
  // clicks it: the affordance is about what they cannot see, and once they are at the bottom there
  // is nothing they cannot see.
  it("stops saying it once the reader scrolls back down themselves", () => {
    const view = render(<Harness itemCount={3} live streaming streamedChars={10} />);
    const el = view.getByTestId("scroller");
    intoHistory(el);
    act(() => {
      view.rerender(<Harness itemCount={3} live streaming streamedChars={48} />);
    });
    expect(screen.queryByTestId("new-output")).not.toBeNull();

    act(() => {
      toTheBottom(el);
    });

    expect(screen.queryByTestId("new-output")).toBeNull();
  });

  // cm:guard a room switch is not new output in the room a reader arrives in, and the pill is state
  // rather than a derived value — so without this it would follow them across the switch and point
  // at the bottom of a thread they are already at.
  it("says nothing in a conversation the reader has just opened", () => {
    const view = render(<Harness itemCount={3} live streaming streamedChars={10} />);
    intoHistory(view.getByTestId("scroller"));
    act(() => {
      view.rerender(<Harness itemCount={3} live streaming streamedChars={48} />);
    });
    expect(screen.queryByTestId("new-output")).not.toBeNull();

    act(() => {
      view.rerender(
        <Harness conversationKey="c2" itemCount={9} live={false} streamedChars={0} />,
      );
    });

    expect(screen.queryByTestId("new-output")).toBeNull();
  });
});

// cm:guard the pill is about OUTPUT and the effect that raises it also runs on two lifecycle
// dependencies, which is how it came to announce nothing at all: a send resolving or a turn ending
// moves `live` and `streaming` with the thread's content untouched, and a reader up the thread was
// told there was something new to see (scroll consult F2).
describe("what counts as new output", () => {
  const intoHistory = (el: HTMLElement) =>
    scrollIntoHistory(el, () => el.dispatchEvent(new Event("scroll", { bubbles: true })));

  it("says nothing when a send resolves with the thread unchanged", () => {
    const view = render(<Harness itemCount={3} live streaming streamedChars={48} />);
    intoHistory(view.getByTestId("scroller"));

    act(() => {
      view.rerender(<Harness itemCount={3} live={false} streaming={false} streamedChars={48} />);
    });

    expect(screen.queryByTestId("new-output")).toBeNull();
  });

  // cm:guard and the positive case is asserted in the SAME shape, so what separates them is the one
  // thing that should: the content moved.
  it("says so when the same lifecycle change carries output with it", () => {
    const view = render(<Harness itemCount={3} live streaming streamedChars={48} />);
    intoHistory(view.getByTestId("scroller"));

    act(() => {
      view.rerender(<Harness itemCount={3} live={false} streaming={false} streamedChars={96} />);
    });

    expect(screen.queryByTestId("new-output")).not.toBeNull();
  });

  it("says so for a new row as well as for a turn that grew", () => {
    const view = render(<Harness itemCount={3} live streaming streamedChars={48} />);
    intoHistory(view.getByTestId("scroller"));

    act(() => {
      view.rerender(<Harness itemCount={4} live streaming streamedChars={48} />);
    });

    expect(screen.queryByTestId("new-output")).not.toBeNull();
  });
});

// cm:guard the SESSION screen's growth signal, which it did not have at all: its turn rows grow in
// place, so `itemCount` does not move and `live` was already true, and it carried the defect
// PR #480 fixed for the chat panel — the thread followed the first frame and then stopped, and a
// reader up the thread was never told the rest had arrived (scroll consult F3). `tailOutputSize` has
// exactly one caller, so what goes red here is what that screen passes.
describe("the growth of a turn whose rows change in place", () => {
  const turnOf = (blocks: RenderBlock[]): ConversationItem => ({
    kind: "agent",
    id: "a1",
    turnId: "a1",
    turnIndex: 1,
    role: "assistant",
    thinkingCount: 0,
    text: "",
    blocks,
    attachments: [],
    editedAt: null,
  });
  const tool = (result?: unknown): RenderBlock => ({
    type: "tool",
    tool: { id: "t1", name: "Read", ...(result === undefined ? {} : { result }) },
  });

  it("moves when the newest turn's prose grows", () => {
    const before = tailOutputSize([turnOf([{ type: "text", text: "Two issues" }])]);
    const after = tailOutputSize([turnOf([{ type: "text", text: "Two issues are left" }])]);
    expect(after).toBeGreaterThan(before);
  });

  // cm:guard THE case a text-length signal would have missed: a result settling onto a card adds
  // height to the thread and not one character to its prose, and a reader following the turn would
  // have been dropped at the exact moment it got taller.
  it("moves when a tool result settles onto a card, with no prose to show for it", () => {
    const before = tailOutputSize([turnOf([{ type: "text", text: "Let me look" }, tool()])]);
    const after = tailOutputSize([
      turnOf([{ type: "text", text: "Let me look" }, tool({ open: 3 })]),
    ]);
    expect(after).not.toBe(before);
  });

  it("holds still where nothing moved, and is zero for a thread with no turns", () => {
    const items = [turnOf([{ type: "text", text: "Two issues are left" }])];
    expect(tailOutputSize(items)).toBe(tailOutputSize(items));
    expect(tailOutputSize([])).toBe(0);
  });
});

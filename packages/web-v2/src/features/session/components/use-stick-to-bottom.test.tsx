// ISS-1006, the owner's dashboard with the Ask Agent panel open: the page read as a top strip over
// white. The thread kept itself at its end with `scrollIntoView` on a sentinel, which scrolls every
// ancestor that can scroll, an `overflow: hidden` workspace shell included, so the whole shell moved
// up out of the window. The thread now moves its own scroller and nothing else. Planted red by
// scrolling the sentinel into view again.
//
// @direct-test-of packages/web-v2/src/features/session/components/use-stick-to-bottom.ts

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStickToBottom } from "./use-stick-to-bottom";

function Thread({ items, streaming }: { items: number; streaming: boolean }) {
  const { scrollRef } = useStickToBottom({ conversationKey: "room-1", ready: true, itemCount: items, live: streaming, streaming, streamedChars: items });
  return (
    // the workspace shell and the panel: `overflow: hidden`, which a script can still scroll
    <div data-testid="shell" style={{ overflow: "hidden", height: 100 }}>
      <div ref={scrollRef} data-testid="scroller" style={{ overflowY: "auto", height: 80 }}>
        {Array.from({ length: items }, (_, i) => (
          <p key={i}>message {i}</p>
        ))}
      </div>
    </div>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("the thread keeps itself at its newest output without moving the page around it", () => {
  it("moves only its own scroller, on opening and as a turn streams in", () => {
    const intoView = vi.fn();
    Element.prototype.scrollIntoView = intoView;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
    const { getByTestId, rerender } = render(<Thread items={3} streaming={false} />);
    const scroller = getByTestId("scroller");
    expect(scroller.scrollTop).toBe(900);
    rerender(<Thread items={4} streaming />);
    rerender(<Thread items={5} streaming />);
    expect(scroller.scrollTop).toBe(900);
    expect(intoView).not.toHaveBeenCalled();
    expect(getByTestId("shell").scrollTop).toBe(0);
  });
});

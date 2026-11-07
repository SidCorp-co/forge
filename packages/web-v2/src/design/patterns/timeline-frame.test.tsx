// A timeline narrower than its lanes opens at its now end (ISS-1072): on a phone the axis ran from
// two hours ago and stopped at 05:00 off the right edge, the latest marks out of sight, until the
// reader scrolled. A frame that fits draws as it is.
// @direct-test-of packages/web-v2/src/design/patterns/timeline.tsx

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineFrame } from "./timeline";

function sized(scrollWidth: number, clientWidth: number) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(scrollWidth);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(clientWidth);
  render(
    <TimelineFrame label="Activity">
      <p>lanes</p>
    </TimelineFrame>,
  );
  return screen.getByTestId("timeline-frame");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a timeline frame", () => {
  it("opens scrolled to its now end where its lanes are wider than it", () => {
    expect(sized(900, 400).scrollLeft).toBe(900);
  });

  it("stays at its start where the lanes fit", () => {
    expect(sized(900, 900).scrollLeft).toBe(0);
  });
});

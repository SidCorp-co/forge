// @vitest-environment jsdom
//
// ISS-1229 r25, the master's read of the after-shots: "Where the work is sitting" drew one small
// square for 1 of 1 issues in flight. The composition spans its width, each category by its share.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CompositionBar } from "./composition-bar";

afterEach(cleanup);

const segments = () =>
  [...document.querySelectorAll<HTMLElement>("[data-composition-segment]")].map((s) => [
    s.dataset.compositionSegment,
    s.style.width,
  ]);

describe("a composition bar", () => {
  it("spans the whole width with the one category that holds every issue", () => {
    render(
      <CompositionBar
        categories={[
          { key: "open", label: "Open", count: 0, color: "gray" },
          { key: "in_flight", label: "In flight", count: 1, color: "blue" },
        ]}
      />,
    );
    expect(segments()).toEqual([["in_flight", "100%"]]);
  });

  it("gives each category its share of the width", () => {
    render(
      <CompositionBar
        categories={[
          { key: "open", label: "Open", count: 3, color: "gray" },
          { key: "in_flight", label: "In flight", count: 1, color: "blue" },
        ]}
      />,
    );
    expect(segments()).toEqual([
      ["open", "75%"],
      ["in_flight", "25%"],
    ]);
  });

  it("draws nothing when there is nothing to share out", () => {
    const { container } = render(
      <CompositionBar categories={[{ key: "open", label: "Open", count: 0, color: "gray" }]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

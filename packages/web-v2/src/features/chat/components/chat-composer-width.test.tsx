// @vitest-environment jsdom
//
// ISS-1264 — the shared `ResizeObserver` reports what an element measures, and jsdom measures every
// element at 0. A frame of 0 is a frame with no box (hidden, detached, or no layout engine at all),
// so it is as unmeasured as before the first reading, and the mode control in the footer draws the
// full track until the frame has a width to shrink against.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { stubLayout } from "@/test-support/layout";
import { notifyResize } from "@/test-support/resize-observer";
import { ChatComposer, ComposerWidthContext } from "./chat-composer";

expect.extend(matchers);

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

function Reads() {
  const width = useContext(ComposerWidthContext);
  return <span data-testid="read-width">{width === null ? "unmeasured" : String(width)}</span>;
}

function open(frame: number) {
  restore = stubLayout((el) => (el.dataset.testid === "chat-composer" ? { width: frame } : undefined));
  render(<ChatComposer onSend={async () => {}} footerControl={<Reads />} />);
}

describe("the width the composer hands its footer control", () => {
  it("is unmeasured while the frame has no width", async () => {
    open(0);
    await act(async () => {});
    expect(screen.getByTestId("read-width")).toHaveTextContent("unmeasured");
  });

  it("is the frame's width once it has one", async () => {
    open(420);
    await act(async () => {});
    expect(screen.getByTestId("read-width")).toHaveTextContent("420");
  });

  it("follows the frame when it is resized, and goes back to unmeasured when it loses its box", async () => {
    let width = 900;
    restore = stubLayout((el) => (el.dataset.testid === "chat-composer" ? { width } : undefined));
    render(<ChatComposer onSend={async () => {}} footerControl={<Reads />} />);
    await act(async () => {});
    expect(screen.getByTestId("read-width")).toHaveTextContent("900");

    width = 360;
    await act(async () => notifyResize(screen.getByTestId("chat-composer")));
    expect(screen.getByTestId("read-width")).toHaveTextContent("360");

    width = 0;
    await act(async () => notifyResize(screen.getByTestId("chat-composer")));
    expect(screen.getByTestId("read-width")).toHaveTextContent("unmeasured");
  });
});

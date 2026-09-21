// @vitest-environment jsdom
//
// ISS-1079 — the one line that draws a turn's pauses, mounted for real.
// Matchers are extended on vitest's OWN `expect` (not the
// `@testing-library/jest-dom/vitest` convenience entry) because that entry
// resolves its own vitest peer, which under pnpm hoisting can land on a
// different vitest than the one running this file.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThinkingLine, thinkingLabel } from "./thinking-line";

expect.extend(matchers);

afterEach(cleanup);

describe("the collapsed label", () => {
  it("says how long the model thought when a duration was measured", () => {
    expect(thinkingLabel({ text: "hmm", durationMs: 4_000 })).toBe("Thought for 4s");
    expect(thinkingLabel({ text: "hmm", durationMs: 420 })).toBe("Thought for 420ms");
    expect(thinkingLabel({ text: "hmm", durationMs: 4_260 })).toBe("Thought for 4.3s");
    expect(thinkingLabel({ text: "hmm", durationMs: 42_000 })).toBe("Thought for 42s");
  });

  it("says how many times it paused when that is all there is", () => {
    expect(thinkingLabel({ count: 1 })).toBe("Thought once");
    expect(thinkingLabel({ count: 3 })).toBe("Thought 3 times");
  });

  it("says plainly that it thought when there is neither", () => {
    expect(thinkingLabel({ text: "hmm" })).toBe("Thought");
  });

  it("speaks in the present tense while the block is still open", () => {
    expect(thinkingLabel({ text: "let me", streaming: true })).toBe("Thinking…");
    expect(thinkingLabel({ text: "let me", durationMs: 400, streaming: true })).toBe(
      "Thought for 400ms",
    );
  });
});

describe("a pause with reasoning to read", () => {
  it("collapses to a line and opens onto the text", () => {
    render(<ThinkingLine text="let me check the list" durationMs={420} />);

    expect(screen.getByTestId("thinking-line")).toBeInTheDocument();
    expect(screen.queryByTestId("thinking-line-text")).toBeNull();

    fireEvent.click(screen.getByTestId("thinking-line-toggle"));

    expect(screen.getByTestId("thinking-line-text")).toHaveTextContent("let me check the list");
  });

  it("reports whether it is open, so the control is not a mystery to a screen reader", () => {
    render(<ThinkingLine text="hmm" />);
    const toggle = screen.getByTestId("thinking-line-toggle");

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});

describe("a pause with nothing to read", () => {
  it("offers no control at all when there is only a count", () => {
    render(<ThinkingLine count={3} />);

    expect(screen.getByTestId("thinking-line")).toHaveTextContent("Thought 3 times");
    expect(screen.queryByTestId("thinking-line-toggle")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers no control when the text is present but empty", () => {
    render(<ThinkingLine text="" durationMs={100} />);

    expect(screen.queryByTestId("thinking-line-toggle")).toBeNull();
    expect(screen.getByTestId("thinking-line")).toHaveTextContent("Thought for 100ms");
  });
});

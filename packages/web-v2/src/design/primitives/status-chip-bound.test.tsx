// @vitest-environment jsdom
//
// The chip's text is bounded, ISS-999.
//
// `stage` is the step a session RECORDED, and that is untyped jsonb the server writes. Until this
// change the caller folded every value onto a seven-word vocabulary, so the chip's width was bounded
// by accident; the truthful value carries no such bound.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusChip } from "./status-chip";

expect.extend(matchers);
afterEach(cleanup);

const LONG = "a-very-long-step-name-nobody-should-have-recorded-but-the-column-is-jsonb";

describe("StatusChip's text is bounded and keeps its whole self (ISS-999)", () => {
  it("truncates a long recorded step rather than widening the row", () => {
    render(<StatusChip status="running" stage={LONG} domain="session" />);
    const text = screen.getByTitle(`running · ${LONG}`);
    expect(text.className).toContain("truncate");
    expect(text.className).toMatch(/max-w-/);
  });

  // cm:guard truncation may not COST the reader the value: the whole string stays in the DOM and in `title`, so it is selectable, searchable and hoverable
  it("keeps the whole step in the DOM and in the title", () => {
    render(<StatusChip status="running" stage={LONG} domain="session" />);
    expect(screen.getByTitle(`running · ${LONG}`)).toHaveTextContent(LONG);
  });

  it("bounds an ordinary label the same way, with no stage at all", () => {
    render(<StatusChip status="queued" domain="issue" />);
    expect(screen.getByTitle("Queued")).toBeInTheDocument();
  });
});

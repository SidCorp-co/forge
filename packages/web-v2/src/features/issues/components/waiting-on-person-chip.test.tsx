// @vitest-environment jsdom
//
// ISS-1257 — the Issues list row says which issues wait on a person, and for how long.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WaitingOnPersonChip } from "./waiting-on-person-chip";

expect.extend(matchers);
afterEach(cleanup);

const NOW = Date.parse("2026-09-27T12:00:00Z");

describe("WaitingOnPersonChip", () => {
  it("says a person is owed an answer and how long it has waited, against the list's one clock", () => {
    render(<WaitingOnPersonChip since="2026-09-24T12:00:00Z" status="in_progress" now={NOW} />);
    expect(screen.getByTestId("waiting-on-person")).toHaveTextContent("Waiting on a person · 3d");
  });

  it("renders nothing for an issue no question waits on", () => {
    const { container } = render(<WaitingOnPersonChip since={null} status="in_progress" now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing rather than NaN for a timestamp it cannot read", () => {
    const { container } = render(<WaitingOnPersonChip since="not a date" status="in_progress" now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["open", "testing", "needs_info", "waiting", "on_hold", "reopen"] as const)(
    "says it on a %s issue, which a question leaves in Blocked on a person",
    (status) => {
      render(<WaitingOnPersonChip since="2026-09-24T12:00:00Z" status={status} now={NOW} />);
      expect(screen.getByTestId("waiting-on-person")).toBeInTheDocument();
    },
  );

  // Criterion 4: a question leaves these states as they were, so the row must not say blocked.
  it.each(["draft", "closed", "dropped", "awaiting_release", "tested"] as const)(
    "renders nothing on a %s issue, whose state a question does not move",
    (status) => {
      const { container } = render(
        <WaitingOnPersonChip since="2026-09-24T12:00:00Z" status={status} now={NOW} />,
      );
      expect(container).toBeEmptyDOMElement();
    },
  );
});

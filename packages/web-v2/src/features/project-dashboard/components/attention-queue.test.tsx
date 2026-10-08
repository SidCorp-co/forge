// @vitest-environment jsdom
//
// ISS-1156 — an empty list is "All caught up" only where nothing is owed beyond it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttentionQueue } from "./attention-queue";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("the Needs your attention list with nothing in it", () => {
  it("says all caught up where nothing is owed", () => {
    render(<AttentionQueue items={[]} cut={null} slug="pair" now={0} />);
    expect(screen.getByText("All caught up")).toBeInTheDocument();
  });

  it("does not say all caught up where more is owed than the list reached", () => {
    render(<AttentionQueue items={[]} cut={{ shown: 0, atLeast: 3, peopleCut: true }} slug="pair" now={0} />);
    expect(screen.queryByText("All caught up")).toBeNull();
    expect(screen.getByText("Nothing is listed to act on here.")).toBeInTheDocument();
    expect(screen.getByText(/Showing 0 of at least 3\./u)).toBeInTheDocument();
  });

  it("does not say all caught up where the response was refused", () => {
    render(<AttentionQueue items={[]} cut={null} refusal="Needs you cannot say how much it leaves out." slug="pair" now={0} />);
    expect(screen.queryByText("All caught up")).toBeNull();
    expect(screen.getByTestId("attention-refusal")).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
//
// ISS-1229 r48: a message's run log whose read failed said so with no way to read it again.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const refetch = vi.fn();
vi.mock("../hooks", () => ({
  useImprovementMessageRuns: () => ({
    data: undefined,
    isLoading: false,
    isError: true,
    error: new Error("The server is down."),
    refetch,
  }),
}));

const { RunLog } = await import("./improve-screen");

afterEach(cleanup);

describe("a run log whose read failed", () => {
  it("says it could not be loaded, never that there are no runs, and Retry reads it again", () => {
    render(<RunLog projectId="p1" scheduleId="s1" slug="forge-dev" />);
    const failure = screen.getByRole("alert");
    expect(failure).toHaveTextContent("Couldn't load this message's run history. The server is down.");
    expect(screen.queryByText("No runs yet.")).toBeNull();
    fireEvent.click(within(failure.parentElement as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

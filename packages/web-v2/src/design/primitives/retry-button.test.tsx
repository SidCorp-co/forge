// @vitest-environment jsdom
//
// ISS-1229 r51, judge-158 on 479: the wait a Retry-After named was worked out once, so 47 seconds after a
// 30-second wait the screen still said 30. The one Retry says how long is left in its own place, counting
// down, and comes back when the wait is over; a refusal the rule offers no Retry for says no wait at all.
import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { RetryButton } from "./retry-button";

expect.extend(matchers);
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the one Retry while the server's wait runs (criterion 479)", () => {
  it.each(["button", "link"] as const)("as a %s, counts the wait down in Retry's place and offers Retry at zero", (look) => {
    const onRetry = vi.fn();
    render(<RetryButton look={look} error={new ApiError(429, "", "RATE_LIMITED", undefined, undefined, 3_000)} onRetry={onRetry} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByTestId("retry-wait")).toHaveTextContent("You can retry in 3 seconds.");
    act(() => void vi.advanceTimersByTime(1_000));
    expect(screen.getByTestId("retry-wait")).toHaveTextContent("You can retry in 2 seconds.");
    act(() => void vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId("retry-wait")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("says no wait, and offers no Retry, on a refusal that carried Retry-After", () => {
    render(<RetryButton error={new ApiError(403, "No.", "FORBIDDEN", undefined, undefined, 60_000)} onRetry={vi.fn()} />);
    expect(screen.queryByTestId("retry-wait")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers Retry at once where the server named no wait", () => {
    render(<RetryButton error={new ApiError(503, "Busy.")} onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

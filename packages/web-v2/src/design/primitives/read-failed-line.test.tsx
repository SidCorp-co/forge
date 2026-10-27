// @vitest-environment jsdom
//
// ISS-1229 r48: the line a list or a choice shows where its read failed says what, why, and Retry.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { ReadFailedLine } from "./read-failed-line";

expect.extend(matchers);
afterEach(cleanup);

describe("a read-failed line", () => {
  it("names what could not be loaded and why, as an alert", () => {
    render(<ReadFailedLine what="the organization's members" why="The server is down." error={undefined} onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the organization's members. The server is down.");
  });

  it("reads again when Retry is pressed", () => {
    const read = vi.fn();
    render(<ReadFailedLine what="the devices" why="The server is down." error={new ApiError(503, "Down")} onRetry={read} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(read).toHaveBeenCalledTimes(1);
  });
});

// ISS-1229 r50, judge-152 on criterion 478: a refusal a second read cannot change is named without a Retry.
describe("a read-failed line refused for good", () => {
  it("names the failure and offers no Retry", () => {
    render(<ReadFailedLine what="the devices" why="You do not have access." error={new ApiError(403, "No.")} onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the devices. You do not have access.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

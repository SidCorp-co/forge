// @vitest-environment jsdom
//
// ISS-1229 r48: the line a list or a choice shows where its read failed says what, why, and Retry.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadFailedLine } from "./read-failed-line";

expect.extend(matchers);
afterEach(cleanup);

describe("a read-failed line", () => {
  it("names what could not be loaded and why, as an alert", () => {
    render(<ReadFailedLine what="the organization's members" why="The server is down." onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the organization's members. The server is down.");
  });

  it("reads again when Retry is pressed", () => {
    const read = vi.fn();
    render(<ReadFailedLine what="the devices" why="The server is down." onRetry={read} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(read).toHaveBeenCalledTimes(1);
  });
});

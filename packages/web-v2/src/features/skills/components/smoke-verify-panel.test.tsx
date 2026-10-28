// @vitest-environment jsdom
//
// ISS-1229 r48: the skill verification report whose read failed said so with no way to read it again.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const refetch = vi.fn();
vi.mock("../hooks", () => ({
  useSkillSmokeVerify: () => ({
    data: undefined,
    isLoading: false,
    isError: true,
    error: new Error("The server is down."),
    refetch,
  }),
  useRunSmokeVerify: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { SmokeVerifyPanel } = await import("./smoke-verify-panel");

afterEach(cleanup);

describe("a skill verification report whose read failed", () => {
  it("says it could not be loaded, and Retry reads it again", () => {
    render(<SmokeVerifyPanel projectId="p1" canManage />);
    const failure = screen.getByRole("alert");
    expect(failure).toHaveTextContent("Couldn't load the verification report. The server is down.");
    fireEvent.click(within(failure.parentElement as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

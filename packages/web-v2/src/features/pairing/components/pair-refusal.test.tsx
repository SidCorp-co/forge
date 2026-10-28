// @vitest-environment jsdom
//
// ISS-1229 r54, judge-168: when Approve on /pair was refused, the refusal was a banner with no live role, so a screen
// reader was told nothing and focus stayed on Approve. It is said as it appears, as every other refusal is.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const refusedWith = vi.hoisted(() => ({ error: null as unknown }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("code=ABCD-1234") }));
vi.mock("../hooks", () => ({
  useApproveDevice: () => ({ isError: refusedWith.error !== null, error: refusedWith.error, data: undefined, isPending: false, mutate: () => {} }),
}));
vi.mock("@/features/agent-accounts/hooks", () => ({ useAgentAccounts: () => ({ data: [], isLoading: false, isError: false }) }));
vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrg: { id: "org-1", role: "member", name: "Acme" } }) }));

const { PairScreen } = await import("./pair-screen");
const { ApiError } = await import("@/lib/api/client");

afterEach(() => {
  cleanup();
  refusedWith.error = null;
});

describe("Approve a device, refused", () => {
  it("says the refusal to a screen reader as it appears", () => {
    refusedWith.error = new ApiError(429, "Too many requests in a short time. Try again in 40 minutes.", "RATE_LIMITED", undefined, undefined, 2_400_000, false);
    render(<PairScreen />);
    expect(screen.getByRole("alert")).toHaveTextContent("Too many requests in a short time. Try again in 40 minutes.");
  });

  it("says nothing as an alert before anything was refused", () => {
    render(<PairScreen />);
    expect(screen.getByRole("button", { name: /Approve/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

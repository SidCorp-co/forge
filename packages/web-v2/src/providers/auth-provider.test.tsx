// @vitest-environment jsdom
//
// ISS-1228 round 23 (judge-74, criterion 235): a page opened while the browser could not reach Forge
// went to Sign in. The account read failing is not Forge saying the person is signed out; only a 401 is.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { markUnreachable } from "@/lib/api/transport-failure";

const me = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/api/auth-api", () => ({ authApi: { me: () => me() } }));

const { AuthProvider, useAuth } = await import("./auth-provider");

let seen: ReturnType<typeof useAuth>;
function Probe() {
  seen = useAuth();
  return <p>{seen.user ? "signed in" : seen.failure ? "unread" : seen.isLoading ? "reading" : "signed out"}</p>;
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const lost = () => {
  const err = new TypeError("Failed to fetch");
  markUnreachable(err);
  return err;
};

beforeEach(() => {
  me.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(cleanup);

async function mounted() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await settle();
}

describe("what the account read failing says about the person (criterion 235)", () => {
  it("keeps a lost connection as a failure, never a sign-out", async () => {
    const err = lost();
    me.mockRejectedValueOnce(err);
    await mounted();
    expect(screen.getByText("unread")).toBeTruthy();
    expect(seen).toMatchObject({ user: null, isLoading: false, failure: err });
  });

  it("keeps a server failure as a failure, never a sign-out", async () => {
    me.mockRejectedValueOnce(new ApiError(503, "Forge is restarting.", "UNAVAILABLE"));
    await mounted();
    expect(screen.getByText("unread")).toBeTruthy();
  });

  it("reads a 401 as signed out", async () => {
    me.mockRejectedValueOnce(new ApiError(401, "Unauthenticated", "UNAUTHENTICATED"));
    await mounted();
    expect(screen.getByText("signed out")).toBeTruthy();
    expect(seen.failure).toBeNull();
  });

  it("signs out a person read in once a later read answers 401", async () => {
    me.mockResolvedValueOnce({ id: "u1", email: "a@b.c", displayName: null }).mockRejectedValueOnce(
      new ApiError(401, "Unauthenticated", "UNAUTHENTICATED"),
    );
    await mounted();
    expect(screen.getByText("signed in")).toBeTruthy();
    await act(async () => seen.retry());
    await settle();
    expect(screen.getByText("signed out")).toBeTruthy();
  });

  it("reads the account again on Retry, and once it answers the person is signed in", async () => {
    me.mockRejectedValueOnce(lost()).mockResolvedValueOnce({ id: "u1", email: "a@b.c", displayName: null });
    await mounted();
    expect(screen.getByText("unread")).toBeTruthy();
    await act(async () => seen.retry());
    await settle();
    expect(screen.getByText("signed in")).toBeTruthy();
    expect(seen.failure).toBeNull();
  });

  it("reads the account again once the browser says the connection is back", async () => {
    me.mockRejectedValueOnce(lost()).mockResolvedValueOnce({ id: "u1", email: "a@b.c", displayName: null });
    await mounted();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();
    expect(me).toHaveBeenCalledTimes(2);
    expect(screen.getByText("signed in")).toBeTruthy();
  });
});

// The loop the owner saw on 2026-10-10: a page with no session goes to /login, /login sends it back,
// and round again. The first bounce is made; the second, inside the window, is not.

import { cleanup, render, screen } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInStopped } from "./components/sign-in-stopped";
import { BOUNCE_WINDOW_MS, bouncedRecently, clearBounce, leaveForLogin } from "./login-bounce";
import { useLoginRedirect } from "./use-login-redirect";

const assign = vi.fn();

beforeEach(() => {
  window.sessionStorage.clear();
  window.name = "";
  assign.mockClear();
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("leaveForLogin", () => {
  it("navigates to /login on the first bounce, hard, and refuses the second", () => {
    expect(leaveForLogin(1_000)).toBe("left");
    expect(assign).toHaveBeenCalledWith("/login");
    expect(leaveForLogin(2_000)).toBe("stopped");
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("is a first bounce again once the window passed (boundary), or the session was open", () => {
    leaveForLogin(1_000);
    expect(bouncedRecently(1_000 + BOUNCE_WINDOW_MS - 1)).toBe(true);
    expect(bouncedRecently(1_000 + BOUNCE_WINDOW_MS)).toBe(false);
    clearBounce();
    expect(leaveForLogin(5_000)).toBe("left");
  });

  it("still stops the loop where the frame lets nothing be stored, by the tab's own name", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(leaveForLogin(1_000)).toBe("left");
    expect(leaveForLogin(2_000)).toBe("stopped");
    vi.restoreAllMocks();
  });
});

describe("useLoginRedirect", () => {
  it("redirects once for a signed-out page and reports stopped for the second mount", () => {
    const first = renderHook(() => useLoginRedirect(true, false));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(first.result.current.stopped).toBe(false);
    first.unmount();
    const second = renderHook(() => useLoginRedirect(true, false));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(second.result.current.stopped).toBe(true);
  });

  it("does nothing while the session is still being asked for, and clears on a signed-in page", () => {
    const { rerender } = renderHook(({ out, inn }) => useLoginRedirect(out, inn), {
      initialProps: { out: false, inn: false },
    });
    expect(assign).not.toHaveBeenCalled();
    rerender({ out: true, inn: false });
    expect(assign).toHaveBeenCalledTimes(1);
    rerender({ out: false, inn: true });
    expect(bouncedRecently()).toBe(false);
  });
});

describe("SignInStopped", () => {
  it("names the cause for a page that is not framed, and navigates only on the person's click", () => {
    render(<SignInStopped />);
    expect(screen.getByText("You are not signed in")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "Go to sign in" }).click();
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("names cookies blocked in the frame when it is framed", () => {
    vi.stubGlobal("top", {});
    render(<SignInStopped />);
    expect(screen.getByText("This frame cannot keep you signed in")).toBeTruthy();
  });
});

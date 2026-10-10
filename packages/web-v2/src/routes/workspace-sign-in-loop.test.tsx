// The loop the owner saw on a preview of Forge (2026-10-10): no session, so the workspace goes to
// /login, /login sends the browser back, and round again for ever. The shell goes once, by a hard
// navigation; the second time inside the window it stops and names the cause.

import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/providers/auth-provider";
import { fakeCore, renderWithQuery } from "@/test/render";

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, prefetch: vi.fn() }),
  usePathname: () => "/",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/utils/use-location-search", () => ({ useLocationSearch: () => "" }));

import WorkspaceLayout from "./(workspace)/layout";

const assign = vi.fn();

beforeEach(() => {
  window.sessionStorage.clear();
  assign.mockClear();
  nav.replace.mockClear();
  vi.stubGlobal("location", { ...window.location, assign });
  fakeCore((c) =>
    c.path === "/auth/me"
      ? { status: 401, body: { code: "UNAUTHENTICATED", message: "no session" } }
      : { status: 404, body: { code: "NOT_SERVED" } },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("a workspace page with no session", () => {
  it("goes to /login once, by a hard navigation, never by the client router", async () => {
    renderWithQuery(<AuthProvider><WorkspaceLayout><div /></WorkspaceLayout></AuthProvider>);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(new URL("/login", window.location.origin)));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(nav.replace).not.toHaveBeenCalledWith(new URL("/login", window.location.origin));
  });

  it("stops on a page naming the cause when the previous navigation already bounced", async () => {
    window.sessionStorage.setItem("forge.loginBounce", String(Date.now()));
    renderWithQuery(<AuthProvider><WorkspaceLayout><div data-testid="page" /></WorkspaceLayout></AuthProvider>);
    expect(await screen.findByRole("button", { name: "Go to sign in" })).toBeTruthy();
    expect(screen.getByText("You are not signed in")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByTestId("page")).toBeNull();
  });

  it("a person who comes back after the window is bounced once more, not stopped", async () => {
    window.sessionStorage.setItem("forge.loginBounce", String(Date.now() - 31_000));
    renderWithQuery(<AuthProvider><WorkspaceLayout><div /></WorkspaceLayout></AuthProvider>);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(new URL("/login", window.location.origin)));
  });
});

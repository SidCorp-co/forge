// The loop the owner saw on a preview of Forge (2026-10-10): no session, so the workspace goes to
// /login, /login sends the browser back, and round again for ever. The shell goes once, by a hard
// navigation; the second time inside the window it stops and names the cause.

import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/providers/auth-provider";
import { fakeCore } from "@/test/render";
import { componentOf, renderRoute } from "@/test/route-tree";

vi.mock("@/lib/utils/use-location-search", () => ({ useLocationSearch: () => "" }));

import { Route as WorkspaceRoute } from "./_workspace/route";

const WorkspaceLayout = componentOf(WorkspaceRoute, "routes/_workspace/route.tsx");
/** The workspace at its home, drawing `page`, under the session the test serves. */
const workspace = (page: () => React.ReactNode) =>
  renderRoute({ at: "/", pattern: "/", page, layout: () => <AuthProvider><WorkspaceLayout /></AuthProvider> });

const assign = vi.fn();

beforeEach(() => {
  window.sessionStorage.clear();
  assign.mockClear();
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
    const { router } = await workspace(() => <div />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(new URL("/login", window.location.origin)));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe("/");
  });

  it("stops on a page naming the cause when the previous navigation already bounced", async () => {
    window.sessionStorage.setItem("forge.loginBounce", String(Date.now()));
    await workspace(() => <div data-testid="page" />);
    expect(await screen.findByRole("button", { name: "Go to sign in" })).toBeTruthy();
    expect(screen.getByText("You are not signed in")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByTestId("page")).toBeNull();
  });

  it("a person who comes back after the window is bounced once more, not stopped", async () => {
    window.sessionStorage.setItem("forge.loginBounce", String(Date.now() - 31_000));
    await workspace(() => <div />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(new URL("/login", window.location.origin)));
  });
});

import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { OperatorClientGate } from "./operator-client-gate";

const replace = vi.fn();
const assign = vi.fn();
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  usePathname: () => "/admin",
}));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ logout: vi.fn() }) }));

describe("OperatorClientGate", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.stubGlobal("location", { ...window.location, assign });
    assign.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends a browser core answers 401 to /login, once, with a hard navigation", async () => {
    fakeCore((c) => (c.path === "/admin/whoami" ? { status: 401, body: { code: "UNAUTHENTICATED", message: "x" } } : undefined));
    renderWithQuery(<OperatorClientGate>child</OperatorClientGate>);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(new URL("/login", window.location.origin)));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("child")).toBeNull();
  });

  it("stops on a page naming the cause when it already bounced to /login and came back", async () => {
    fakeCore((c) => (c.path === "/admin/whoami" ? { status: 401, body: { code: "UNAUTHENTICATED", message: "x" } } : undefined));
    window.sessionStorage.setItem("forge.loginBounce", String(Date.now()));
    renderWithQuery(<OperatorClientGate>child</OperatorClientGate>);
    expect(await screen.findByRole("button", { name: "Go to sign in" })).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("sends a non-admin to /", async () => {
    fakeCore((c) => (c.path === "/admin/whoami" ? { body: { isAdmin: false, email: "a@b.test" } } : undefined));
    renderWithQuery(<OperatorClientGate>child</OperatorClientGate>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });
});

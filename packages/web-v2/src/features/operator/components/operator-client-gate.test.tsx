import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { OperatorClientGate } from "./operator-client-gate";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  usePathname: () => "/admin",
}));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ logout: vi.fn() }) }));

describe("OperatorClientGate", () => {
  it("sends a browser core answers 401 to /login", async () => {
    fakeCore((c) => (c.path === "/admin/whoami" ? { status: 401, body: { code: "UNAUTHENTICATED", message: "x" } } : undefined));
    renderWithQuery(<OperatorClientGate>child</OperatorClientGate>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("child")).toBeNull();
  });

  it("sends a non-admin to /", async () => {
    fakeCore((c) => (c.path === "/admin/whoami" ? { body: { isAdmin: false, email: "a@b.test" } } : undefined));
    renderWithQuery(<OperatorClientGate>child</OperatorClientGate>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });
});

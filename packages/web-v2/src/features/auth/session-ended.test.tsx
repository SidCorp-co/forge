// A browser holding a session core no longer honours is signed out, never shown an error: the
// login form carries one quiet line, and core's raw "invalid token" never reaches the page — the
// sentence the owner saw on forge-dev on 2026-10-08 until they cleared their cookies by hand.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { AuthProvider, useAuth } from "@/providers/auth-provider";
import { fakeCore } from "@/test/render";
import { LoginForm } from "./login-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

afterEach(() => vi.unstubAllGlobals());

const ENDED = {
  status: 401,
  body: { code: "SESSION_EXPIRED", message: "your session has ended; sign in again" },
};
const ME = { id: "u1", email: "owner@forge.test", displayName: null, emailVerifiedAt: null, createdAt: "", lastFreshAuthAt: null, hasPassword: true, oauthProviders: [] };

function signIn() {
  fireEvent.change(screen.getByPlaceholderText("you@studio.com"), { target: { value: "owner@forge.test" } });
  fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "pw" } });
  fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form") as HTMLFormElement);
}

describe("a session that ended", () => {
  it("shows the login form with one quiet line, and no error banner", async () => {
    fakeCore((c) => (c.path === "/auth/me" ? ENDED : undefined));
    render(<AuthProvider><LoginForm /></AuthProvider>);
    expect(await screen.findByRole("status")).toHaveTextContent("Your session ended. Please sign in again.");
    expect(screen.queryByText(/session has ended/)).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("signs a signed-in person out when any later request is answered session-ended", async () => {
    let ended = false;
    fakeCore((c) => {
      if (c.path === "/auth/me") return { body: ME };
      if (c.path !== "/projects") return undefined;
      ended = true;
      return ENDED;
    });
    function Who() {
      const { user, sessionEnded } = useAuth();
      return <p>{user ? user.email : sessionEnded ? "signed out: ended" : "signed out"}</p>;
    }
    render(<AuthProvider><Who /></AuthProvider>);
    await screen.findByText("owner@forge.test");
    await apiClient("/projects").catch(() => undefined);
    expect(ended).toBe(true);
    await screen.findByText("signed out: ended");
  });

  it("never shows core's raw refusal text when signing in fails after the login answered", async () => {
    fakeCore((c) => {
      if (c.path === "/auth/me" && c.method === "GET") return { status: 401, body: { code: "INVALID_TOKEN", message: "invalid token" } };
      if (c.path === "/auth/local") return { body: { token: "t", user: { id: "u1", email: "owner@forge.test", emailVerified: true }, emailVerificationRequired: false } };
      return undefined;
    });
    render(<AuthProvider><LoginForm /></AuthProvider>);
    signIn();
    await waitFor(() => expect(screen.queryByText("Your session is invalid. Please sign in again.")).not.toBeNull());
    expect(screen.queryByText("invalid token")).toBeNull();
  });
});

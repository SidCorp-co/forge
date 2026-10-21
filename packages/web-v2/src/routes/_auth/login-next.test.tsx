// ISS-529 c7 (REQ-46 BC-7): the workspace sends a person with no session to /login?next=<the page>,
// and signing in returns them there, so a GitHub return that could not finish is still read on
// Integrations. `next` is followed only as a path on this origin (features/auth/return-path.ts).

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "@/providers/auth-provider";
import { fakeCore } from "@/test/render";
import { componentOf, renderRoute } from "@/test/route-tree";
import { Route as AuthRoute } from "./route";
import { Route as LoginRoute } from "./login/index";

const AuthLayout = componentOf(AuthRoute, "routes/_auth/route.tsx");
const LoginPage = componentOf(LoginRoute, "routes/_auth/login/index.tsx");

const ME = { id: "u1", email: "owner@forge.test", displayName: null, emailVerifiedAt: "2026-10-01T00:00:00Z", createdAt: "", lastFreshAuthAt: null, hasPassword: true, oauthProviders: [] };
const NO_SESSION = { status: 401, body: { code: "UNAUTHENTICATED", message: "no session" } };

let signedIn = false;
beforeEach(() => {
  signedIn = false;
  fakeCore((c) => {
    if (c.path === "/auth/me") return signedIn ? { body: ME } : NO_SESSION;
    if (c.path === "/auth/local") {
      signedIn = true;
      return { body: { token: "t", user: { id: "u1", email: ME.email, emailVerified: true }, emailVerificationRequired: false } };
    }
    if (c.path === "/auth/oauth/providers") return { body: { providers: [] } };
    return undefined;
  });
});

/** The login page at `at`, under the sign-in layout, as the app mounts it. */
const loginAt = (at: string) =>
  renderRoute({ at, pattern: "/login", page: LoginPage, layout: () => <AuthProvider><AuthLayout /></AuthProvider> });

async function signIn() {
  fireEvent.change(await screen.findByPlaceholderText("you@studio.com"), { target: { value: ME.email } });
  fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "pw" } });
  fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form") as HTMLFormElement);
}

describe("signing in from a bounce", () => {
  it("returns to the page next names, query included", async () => {
    const { router } = await loginAt("/login?next=%2Fintegrations%3Fconnect%3Dno_session");
    await signIn();
    await waitFor(() => expect(router.state.location.href).toBe("/integrations?connect=no_session"));
  });

  it("sends a person already signed in straight on to next", async () => {
    signedIn = true;
    const { router } = await loginAt("/login?next=%2Fintegrations%3Fconnect%3Dstate_expired");
    await waitFor(() => expect(router.state.location.href).toBe("/integrations?connect=state_expired"));
  });

  it.each([
    ["an absolute URL", "https://attacker.example/integrations"],
    ["a protocol-relative URL", "//attacker.example/integrations"],
    ["a backslash the browser reads as a slash", "/\\attacker.example"],
  ])("lands on Home for %s, never following it", async (_what, next) => {
    const { router } = await loginAt(`/login?${new URLSearchParams({ next })}`);
    await signIn();
    await waitFor(() => expect(router.state.location.href).toBe("/"));
    expect(router.state.location.href).not.toContain("attacker");
  });

  it("lands on Home with no next", async () => {
    const { router } = await loginAt("/login");
    await signIn();
    await waitFor(() => expect(router.state.location.href).toBe("/"));
  });
});

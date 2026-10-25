// Each sign-in button shows its own provider's mark (REQ-72): Google's button carried GitHub's
// fallback icon, so "Continue with Google" read as a GitHub sign-in.
// @direct-test-of packages/web-v2/src/features/auth/components/provider-mark.tsx

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeCore } from "@/test/render";
import { SocialLogin } from "./social-login";

const PROVIDERS = {
  status: 200,
  body: {
    providers: [
      { id: "github", label: "Continue with GitHub" },
      { id: "google", label: "Continue with Google" },
      { id: "oidc", label: "Continue with SSO" },
    ],
  },
};

const markOf = async (label: string) =>
  (await screen.findByRole("link", { name: label })).querySelector("svg");

describe("the sign-in buttons", () => {
  it("draws each provider's own mark, and never one provider's logo on another's button", async () => {
    fakeCore((c) => (c.path === "/auth/oauth/providers" ? PROVIDERS : undefined));
    render(<SocialLogin />);
    expect((await markOf("Continue with Google"))?.getAttribute("data-mark")).toBe("google");
    expect((await markOf("Continue with GitHub"))?.getAttribute("data-mark")).toBe("github");
    expect((await markOf("Continue with SSO"))?.hasAttribute("data-mark")).toBe(false);
  });
});

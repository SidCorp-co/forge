import { describe, expect, it } from "vitest";
import { operatorGateDecision } from "./operator-gate";

describe("operatorGateDecision", () => {
  it("redirects an unauthenticated visitor to /login", () => {
    expect(operatorGateDecision({ kind: "unauthenticated" })).toEqual({
      kind: "redirect",
      to: "/login",
    });
  });

  it("redirects a signed-in non-admin to /", () => {
    expect(operatorGateDecision({ kind: "not-admin" })).toEqual({ kind: "redirect", to: "/" });
  });

  it("renders for an admin", () => {
    expect(operatorGateDecision({ kind: "admin", email: "a@b.com" })).toEqual({ kind: "render" });
  });

  it("renders for an unverified email so the layout can explain it", () => {
    expect(operatorGateDecision({ kind: "unverified" })).toEqual({ kind: "render" });
  });

  it("renders when the check itself failed so the layout can offer a retry", () => {
    expect(operatorGateDecision({ kind: "error", message: "boom" })).toEqual({ kind: "render" });
  });
});

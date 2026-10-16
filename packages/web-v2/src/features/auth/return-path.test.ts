import { describe, expect, it } from "vitest";
import { loginHref, returnPathFrom, safeReturnPath } from "./return-path";

describe("the path sign-in returns to", () => {
  it("takes a path and query on this origin", () => {
    expect(safeReturnPath("/oauth/authorize?client_id=a&state=b")).toBe("/oauth/authorize?client_id=a&state=b");
    expect(returnPathFrom(new URLSearchParams({ next: "/link-chat?x=1" }))).toBe("/link-chat?x=1");
  });

  it.each([
    ["another origin", "https://attacker.example/"],
    ["a protocol-relative URL", "//attacker.example/"],
    ["a backslash the browser reads as a slash", "/\\attacker.example"],
    ["a tab inside the path", "/\t/attacker.example"],
    ["a script URL", "javascript:alert(1)"],
    ["nothing", ""],
  ])("refuses %s", (_what, raw) => {
    expect(safeReturnPath(raw)).toBeNull();
  });

  it("builds the /login link carrying the return, and a bare one for a path it refuses", () => {
    expect(loginHref("/oauth/authorize?a=1&b=2")).toBe("/login?next=%2Foauth%2Fauthorize%3Fa%3D1%26b%3D2");
    expect(loginHref("//attacker.example")).toBe("/login");
  });
});

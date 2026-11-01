// @direct-test-of packages/web-v2/src/design/initials.ts
import { describe, expect, it } from "vitest";
import { initialsOf } from "./initials";

describe("initialsOf (ISS-865)", () => {
  it("draws letters only, never a bracket or a mark", () => {
    expect(initialsOf("Epod (ops)")).toBe("EO");
    expect(initialsOf("(Epod)")).toBe("EP");
    expect(initialsOf("Forge Dev")).toBe("FD");
    expect(initialsOf("forge")).toBe("FO");
  });
  it("reads an email from its local part, and says ? for no letters", () => {
    expect(initialsOf("lan.nguyen@sidcorp.co")).toBe("LN");
    expect(initialsOf("chuong@sidcorp.co")).toBe("CH");
    expect(initialsOf("(42)")).toBe("?");
    expect(initialsOf("")).toBe("?");
  });
  it("keeps letters beyond ASCII", () => {
    expect(initialsOf("Đức Anh")).toBe("ĐA"); // i18n-allow: a Vietnamese name proves letters beyond ASCII count
  });
});

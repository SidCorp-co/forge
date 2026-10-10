import { describe, expect, it } from "vitest";
import { resolveInterfaceLanguage } from "./interface-language";

describe("the interface language", () => {
  it("resolves the explicit choice, else English, whatever the input's region", () => {
    expect(resolveInterfaceLanguage("vi")).toBe("vi");
    expect(resolveInterfaceLanguage("vi-VN")).toBe("vi");
    expect(resolveInterfaceLanguage("en")).toBe("en");
    expect(resolveInterfaceLanguage("fr")).toBe("en");
    expect(resolveInterfaceLanguage(null)).toBe("en");
    expect(resolveInterfaceLanguage(undefined)).toBe("en");
  });
});

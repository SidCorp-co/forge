import { describe, expect, it } from "vitest";
import { activeSectionFromPath, hrefForSection } from "./nav-model";

describe("activeSectionFromPath", () => {
  it("resolves the exact overview path", () => {
    expect(activeSectionFromPath("/admin")).toBe("overview");
  });

  it("resolves each sub-route", () => {
    expect(activeSectionFromPath("/admin/alerts")).toBe("alerts");
    expect(activeSectionFromPath("/admin/fleet")).toBe("fleet");
    expect(activeSectionFromPath("/admin/pipeline")).toBe("pipeline");
    expect(activeSectionFromPath("/admin/growth")).toBe("growth");
    expect(activeSectionFromPath("/admin/mcp-logs")).toBe("mcp-logs");
  });

  it("ignores a trailing slash", () => {
    expect(activeSectionFromPath("/admin/alerts/")).toBe("alerts");
  });

  it("falls back to overview for an unknown admin sub-route", () => {
    expect(activeSectionFromPath("/admin/nope")).toBe("overview");
  });

  it("does not let the overview prefix win over a more specific sub-route", () => {
    expect(activeSectionFromPath("/admin/alerts")).not.toBe("overview");
  });
});

describe("hrefForSection", () => {
  it("maps each key back to its href", () => {
    expect(hrefForSection("overview")).toBe("/admin");
    expect(hrefForSection("alerts")).toBe("/admin/alerts");
    expect(hrefForSection("fleet")).toBe("/admin/fleet");
    expect(hrefForSection("pipeline")).toBe("/admin/pipeline");
    expect(hrefForSection("growth")).toBe("/admin/growth");
    expect(hrefForSection("mcp-logs")).toBe("/admin/mcp-logs");
  });
});

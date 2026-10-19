import { describe, expect, it } from "vitest";
import { legacyTab } from "./legacy-tab";

describe("legacyTab — an old ?tab= link goes where its content lives now", () => {
  it("keeps the board on the Issues list, which holds the states the board drew (ISS-1228)", () => {
    expect(legacyTab("forge-dev", "?tab=board")).toEqual({ kind: "redirect", href: "/projects/forge-dev/issues", onIssues: true });
    expect(legacyTab("forge-dev", "?tab=board&q=x")).toEqual({ kind: "redirect", href: "/projects/forge-dev/issues?q=x", onIssues: true });
  });

  it("sends insights to the project dashboard", () => {
    expect(legacyTab("forge-dev", "?tab=insights")).toEqual({ kind: "redirect", href: "/projects/forge-dev", onIssues: false });
  });

  it("opens the list grouped by module for modules, replacing a groupBy and keeping the other params", () => {
    expect(legacyTab("forge-dev", "?tab=modules&groupBy=priority&q=crash")).toEqual({
      kind: "redirect",
      href: "/projects/forge-dev/issues?groupBy=module&q=crash",
      onIssues: true,
    });
  });

  it("opens the bare list for tab=list, keeping what else the link held", () => {
    expect(legacyTab("forge-dev", "?tab=list&module=m1")).toEqual({
      kind: "redirect",
      href: "/projects/forge-dev/issues?module=m1",
      onIssues: true,
    });
    expect(legacyTab("forge-dev", "?tab=list")).toEqual({ kind: "redirect", href: "/projects/forge-dev/issues", onIssues: true });
  });

  it("names a tab the screen never offered instead of reading it as the list", () => {
    expect(legacyTab("forge-dev", "?tab=nope")).toEqual({ kind: "unknown", value: "nope" });
    expect(legacyTab("forge-dev", "?tab=")).toEqual({ kind: "unknown", value: "" });
  });

  it("leaves a link with no tab alone", () => {
    expect(legacyTab("forge-dev", "?filter=awaiting_release")).toEqual({ kind: "none" });
    expect(legacyTab("forge-dev", "")).toEqual({ kind: "none" });
  });
});

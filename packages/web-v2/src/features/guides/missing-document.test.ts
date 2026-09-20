import { describe, expect, it } from "vitest";
import { missingGuideDocument } from "./missing-document";
import { slugFromGuidePath } from "./requested-path";

describe("the HTML the middleware serves for an unknown guide", () => {
  it("names the slug that was asked for", () => {
    expect(missingGuideDocument("not-published")).toContain(
      "Forge publishes no guide called “not-published”",
    );
  });

  it("carries a link to the index, so a broken link has a way back", () => {
    expect(missingGuideDocument("x")).toContain('<a href="/guides">All Forge guides</a>');
  });

  it("says the same in the title, which is what a link preview reads", () => {
    expect(missingGuideDocument("x")).toMatch(/<title>[^<]*no guide called[^<]*<\/title>/);
  });

  it("escapes a slug carrying markup rather than writing it into the document", () => {
    const html = missingGuideDocument('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("still refuses when no slug could be read", () => {
    expect(missingGuideDocument("")).toContain("Forge publishes no guide at that address");
  });
});

describe("slugFromGuidePath", () => {
  it("reads the slug out of a guide path", () => {
    expect(slugFromGuidePath("/guides/what-is-an-issue")).toBe("what-is-an-issue");
  });

  it("drops a query string and a trailing slash", () => {
    expect(slugFromGuidePath("/guides/deploy-safety/?x=1")).toBe("deploy-safety");
  });

  it("answers empty for the index itself and for a missing header", () => {
    expect(slugFromGuidePath("/guides")).toBe("");
    expect(slugFromGuidePath(null)).toBe("");
  });
});

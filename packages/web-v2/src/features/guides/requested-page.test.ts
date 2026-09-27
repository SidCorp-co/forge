import { describe, expect, it } from "vitest";
import { refusalDocument } from "./missing-document";
import { readPublicRequest, toSearchParams } from "./requested-page";

const SLUGS = ["getting-started", "connect-an-assistant/cursor"];
const read = (q: string) => readPublicRequest(new URLSearchParams(q), SLUGS);

describe("what an address on /guides asks for", () => {
  it("is the landing with neither path nor for", () => {
    expect(read("")).toEqual({ kind: "landing" });
    expect(read("utm_source=x")).toEqual({ kind: "landing" });
  });

  it("is a door for each of the three audiences", () => {
    for (const a of ["user", "assistant-setup", "agent"]) {
      expect(read(`for=${a}`)).toEqual({ kind: "door", audience: a });
    }
  });

  it("is a help page, a folder page included", () => {
    expect(read("path=connect-an-assistant/cursor")).toEqual({ kind: "page", slug: "connect-an-assistant/cursor" });
  });

  it("refuses a page no help page has, naming it", () => {
    const r = read("path=no-such-page");
    expect(r.kind === "refused" && r.refusal.heading).toBe("Forge publishes no page called “no-such-page”");
  });

  it("refuses an empty path as naming no page", () => {
    const r = read("path=");
    expect(r.kind === "refused" && r.refusal.heading).toBe("The link you followed names no page");
  });

  it("refuses a door that is not an audience, naming it and the valid ones", () => {
    const r = read("for=users");
    expect(r.kind === "refused" && r.refusal.heading).toBe("The documentation has no door called “users”");
    expect(r.kind === "refused" && r.refusal.body).toMatch(/“user” \(I use Forge\).*“assistant-setup”.*“agent”/);
  });

  it("refuses an address naming both a page and a door, even when each is valid", () => {
    const r = read("path=getting-started&for=user");
    expect(r.kind === "refused" && r.refusal.heading).toBe("An address names a page or a door, not both");
  });

  it("escapes a refused value carrying markup in the 404 document", () => {
    const r = read('for=<img src=x onerror="alert(1)">');
    if (r.kind !== "refused") throw new Error("expected a refusal");
    const html = refusalDocument(r.refusal);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("toSearchParams", () => {
  it("keeps repeated keys in order, so the page and the middleware both read the first", () => {
    const p = toSearchParams({ path: ["a", "b"], for: undefined, x: "1" });
    expect(p.get("path")).toBe("a");
    expect(p.has("for")).toBe(false);
    expect(p.get("x")).toBe("1");
  });
});

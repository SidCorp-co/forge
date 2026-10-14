import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIENCES, DOORS, doorHref } from "./audience";
import { DOCUMENT_TOKENS, FONT_SANS_URL, missingGuideDocument, refusalDocument } from "./missing-document";
import { missingDoor, missingPage, PAGE_AND_DOOR } from "./missing";
import { GUIDE_SLUG, slugFromGuidePath } from "./requested-path";

describe("the HTML the middleware serves for an unknown guide", () => {
  it("names the slug that was asked for", () => {
    expect(missingGuideDocument("not-published")).toContain(
      "Forge publishes no guide called “not-published”",
    );
  });

  it("carries a link to the index, so a broken link has a way back", () => {
    expect(missingGuideDocument("x")).toContain('<a href="/guides">All three ways in</a>');
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

  it("keeps the padding a page's route param would see, so neither trims what the other does not", () => {
    expect(slugFromGuidePath("/guides/%20what-is-an-issue%20")).toBe(" what-is-an-issue ");
    expect(GUIDE_SLUG.test(slugFromGuidePath("/guides/%20what-is-an-issue%20"))).toBe(false);
  });

  it("keeps a suffix that will not decode instead of throwing over it", () => {
    expect(() => slugFromGuidePath("/guides/%ZZ")).not.toThrow();
    expect(GUIDE_SLUG.test(slugFromGuidePath("/guides/%ZZ"))).toBe(false);
  });
});

describe("GUIDE_SLUG", () => {
  it("accepts a registry key", () => {
    expect(GUIDE_SLUG.test("what-is-an-issue")).toBe(true);
  });

  it("refuses the .md form core answers 200 for, which the page would reject", () => {
    expect(GUIDE_SLUG.test("what-is-an-issue.md")).toBe(false);
  });

  it("refuses a path and anything carrying markup", () => {
    expect(GUIDE_SLUG.test("../admin/whoami")).toBe(false);
    expect(GUIDE_SLUG.test("<img src=x>")).toBe(false);
  });
});

const REFUSALS = [
  ["an unknown guide", () => missingGuideDocument("no-such-guide")],
  ["an unknown door", () => refusalDocument(missingDoor("bogus-door"))],
  ["an unknown page", () => refusalDocument(missingPage("no-such-page"))],
  ["a page and a door together", () => refusalDocument(PAGE_AND_DOOR)],
] as const;

describe.each(REFUSALS)("the 404 document for %s looks like Forge documentation", (_case, make) => {
  it("is a styled document, not the browser's default one", () => {
    const html = make();
    expect(html).toMatch(/<style>[^<]+<\/style>/);
    expect(html).toContain("background:var(--bg-app)");
  });

  it("has the documentation's header, with its one name and the sentence under it", () => {
    const html = make();
    expect(html).toContain('<header><div class="bar"><a class="brand" href="/guides">Forge documentation</a>');
    expect(html).toContain("For people using Forge, people connecting an assistant, and agents.");
    expect(html).toMatch(/<title>[^<]+ — Forge documentation<\/title>/);
  });

  it("calls the surface by no other name", () => {
    expect(make()).not.toMatch(/Forge guides/i);
  });

  it("offers every door and the landing as the way back", () => {
    const html = make();
    for (const a of AUDIENCES) {
      expect(html).toContain(`<a href="${doorHref(a)}">${DOORS[a].label.replace("'", "'")}</a>`);
    }
    expect(html).toContain('<a href="/guides">All three ways in</a>');
  });
});

describe("the colours the 404 document paints with", () => {
  const tokens = readFileSync(resolve(__dirname, "../../styles/tokens.css"), "utf8");
  const light = tokens.slice(0, tokens.indexOf('\n[data-theme="dark"] {'));

  /** A token's value in the light theme, following `var(--other)` until it is a literal. */
  function resolveToken(name: string): string {
    const match = new RegExp(`${name}:\\s*([^;]+);`).exec(light);
    if (!match) throw new Error(`tokens.css declares no ${name}`);
    const value = match[1].trim();
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    return ref ? resolveToken(ref[1]) : value;
  }

  it.each(Object.entries(DOCUMENT_TOKENS))("%s is what tokens.css says it is", (name, value) => {
    expect(value.toLowerCase()).toBe(resolveToken(name).toLowerCase());
  });

  it("paints only with tokens it declares", () => {
    const used = new Set([...refusalDocument(missingPage("x")).matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
    expect([...used].filter((name) => !(name in DOCUMENT_TOKENS))).toEqual([]);
  });
});

describe("the font the 404 document names", () => {
  const SRC = resolve(__dirname, "../../app/fonts");
  const PUBLIC = resolve(__dirname, "../../../public/fonts");

  it("is the file the app ships, byte for byte, and its licence beside it", () => {
    for (const file of ["hanken-grotesk-latin-variable.woff2", "OFL-hanken-grotesk.txt"]) {
      expect(readFileSync(resolve(PUBLIC, file)).equals(readFileSync(resolve(SRC, file)))).toBe(true);
    }
  });

  it("is declared and preloaded from that file's address", () => {
    expect(FONT_SANS_URL.endsWith("/fonts/hanken-grotesk-latin-variable.woff2")).toBe(true);
    const html = missingGuideDocument("x");
    expect(html).toContain(`src:url("${FONT_SANS_URL}") format("woff2")`);
    expect(html).toContain(`<link rel="preload" href="${FONT_SANS_URL}" as="font"`);
  });
});

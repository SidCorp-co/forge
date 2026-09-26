import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_AUDIENCES, parseFrontmatter, readAudience } from "../../../scripts/help-frontmatter.mjs";
import { HELP_DOCS } from "./help-content.generated";
import { HELP_SLUGS } from "./help-slugs.generated";

const CONTENT = resolve(__dirname, "../../../content/help");

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = join(dir, e.name);
    if (e.isDirectory()) return pages(abs);
    return e.name.endsWith(".md") && e.name !== "README.md" ? [abs] : [];
  });
}

describe("a help page's audience", () => {
  it("is refused by name when the front-matter has none", () => {
    expect(() => readAudience({ title: "X" }, "content/help/x.md")).toThrow(
      /content\/help\/x\.md: no `audience`.*user \| assistant-setup/,
    );
  });

  it("is refused by name when it is empty", () => {
    expect(() => readAudience({ audience: "" }, "content/help/x.md")).toThrow(/no `audience`/);
  });

  it("is refused by name when it is not a help audience, agent included", () => {
    expect(() => readAudience({ audience: "agent" }, "content/help/x.md")).toThrow(
      /content\/help\/x\.md: `audience: agent` is not one a help page may hold\. Valid: user, assistant-setup\./,
    );
    expect(() => readAudience({ audience: "users" }, "content/help/x.md")).toThrow(/audience: users/);
  });

  it("is read when it is one of the two", () => {
    expect(readAudience({ audience: "user" }, "f")).toBe("user");
    expect(readAudience({ audience: "assistant-setup" }, "f")).toBe("assistant-setup");
  });

  it("is declared on every page in content/help, with a value the generator accepts", () => {
    const files = pages(CONTENT);
    expect(files.length).toBeGreaterThan(10);
    const wrong = files.flatMap((abs) => {
      const parsed = parseFrontmatter(readFileSync(abs, "utf8"));
      const audience = (parsed?.meta as Record<string, string> | undefined)?.audience;
      return audience !== undefined && HELP_AUDIENCES.includes(audience) ? [] : [`${relative(CONTENT, abs)}: ${audience}`];
    });
    expect(wrong).toEqual([]);
  });

  it("puts every page of the Connect an assistant folder, and only those, behind the assistant door", () => {
    for (const doc of HELP_DOCS) {
      expect(doc.audience, doc.slug).toBe(
        doc.slug.startsWith("connect-an-assistant/") ? "assistant-setup" : "user",
      );
    }
  });
});

describe("the generated help modules", () => {
  it("list the same pages, so the middleware and the reader agree on what exists", () => {
    expect([...HELP_SLUGS]).toEqual(HELP_DOCS.map((d) => d.slug));
  });
});

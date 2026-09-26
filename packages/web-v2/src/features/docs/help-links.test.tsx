// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "@/design";
import { HELP_DOCS } from "./help-content.generated";

afterEach(cleanup);

const SLUGS = new Set(HELP_DOCS.map((d) => d.slug));
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;

/** Every link the page's own markdown writes that is not an external URL. */
function linksToOtherPages(body: string): string[] {
  return [...body.matchAll(MARKDOWN_LINK)]
    .map((m) => m[1])
    .filter((href) => !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href));
}

/** Where each of those links goes once the Docs viewer has rendered the page. */
function renderedTargets(slug: string, body: string): string[] {
  const { container } = render(
    <Markdown variant="prose" docBasePath={slug}>
      {body}
    </Markdown>,
  );
  return [...container.querySelectorAll("a")]
    .map((a) => a.getAttribute("href") ?? "")
    .filter((href) => href.startsWith("/docs"));
}

describe("every link between help pages", () => {
  it("is written in the one form the help README names", () => {
    const wrong = HELP_DOCS.flatMap((d) =>
      linksToOtherPages(d.body)
        .filter((href) => !/^\?path=[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(href))
        .map((href) => `${d.slug}: (${href}) — write (?path=<slug>)`),
    );
    expect(wrong).toEqual([]);
  });

  it.each(HELP_DOCS.map((d) => [d.slug, d.body] as const))(
    "on %s opens a page that exists",
    (slug, body) => {
      const written = linksToOtherPages(body);
      const targets = renderedTargets(slug, body);
      expect(targets).toHaveLength(written.length);
      const broken = targets.filter(
        (href) => !SLUGS.has(new URLSearchParams(href.slice("/docs".length)).get("path") ?? ""),
      );
      expect(broken, `${slug} links to no page`).toEqual([]);
    },
  );

  it("exists at all, so the walk above cannot pass on an empty corpus", () => {
    expect(HELP_DOCS.flatMap((d) => linksToOtherPages(d.body)).length).toBeGreaterThan(10);
  });
});

/**
 * CI's `docs` job checks the same links with markdown-link-check, which knows nothing of the
 * viewer: `.github/mlc-config.json` rewrites each `?path=` link to a file first. ISS-1175 found the
 * two disagreeing — the rewrite resolved beside the linking page, so a subfolder page's link to a
 * root page read dead there while it opened here, and a slug with a folder in it was not rewritten
 * at all and passed that job unchecked. The rewrite is held here to name the file the viewer opens.
 */
const REPO = resolve(__dirname, "../../../../..");
const HELP_ROOT = join(REPO, "packages/web-v2/content/help");
const MLC = JSON.parse(readFileSync(join(REPO, ".github/mlc-config.json"), "utf8")) as {
  replacementPatterns: Array<{ pattern: string; replacement: string }>;
};

/** The file markdown-link-check checks for `href` written on `slug`'s page, or null for none. */
function fileTheLinkCheckerOpens(slug: string, href: string): string | null {
  let target = href;
  for (const { pattern, replacement } of MLC.replacementPatterns) {
    target = target.replace(new RegExp(pattern), replacement.replaceAll("{{BASEURL}}", REPO));
  }
  if (target === href) return null;
  return target.startsWith("/") ? target : join(dirname(join(HELP_ROOT, slug)), target);
}

describe("the CI link check, on every link between help pages", () => {
  it.each(HELP_DOCS.map((d) => [d.slug, d.body] as const))(
    "on %s checks the file the viewer opens",
    (slug, body) => {
      const wrong = linksToOtherPages(body).flatMap((href) => {
        const opened = join(HELP_ROOT, `${new URLSearchParams(href).get("path")}.md`);
        const checked = fileTheLinkCheckerOpens(slug, href);
        return checked === opened && existsSync(checked) ? [] : [`${href} → ${checked ?? "unchecked"}`];
      });
      expect(wrong).toEqual([]);
    },
  );

  it("follows a link from a subfolder to a root page, and one into a subfolder", () => {
    expect(fileTheLinkCheckerOpens("connect-an-assistant/what-you-can-ask", "?path=issue-statuses")).toBe(
      join(HELP_ROOT, "issue-statuses.md"),
    );
    expect(fileTheLinkCheckerOpens("getting-started", "?path=connect-an-assistant/cursor")).toBe(
      join(HELP_ROOT, "connect-an-assistant/cursor.md"),
    );
  });
});

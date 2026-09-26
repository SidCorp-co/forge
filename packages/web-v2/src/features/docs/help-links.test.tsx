// @vitest-environment jsdom

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
        .filter((href) => !/^\?path=[a-z0-9-]+$/.test(href))
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

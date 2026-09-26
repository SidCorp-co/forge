// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

afterEach(cleanup);

function hrefOf(markdown: string, docBasePath = "issue-statuses"): string | null {
  const { container } = render(<Markdown docBasePath={docBasePath}>{markdown}</Markdown>);
  return container.querySelector("a")?.getAttribute("href") ?? null;
}

describe("a link inside the Docs viewer", () => {
  it("opens the page a ?path= link names", () => {
    expect(hrefOf("[Done](?path=what-done-means)")).toBe("/docs?path=what-done-means");
  });

  it("keeps the slug of a ?path= link that also carries an anchor", () => {
    expect(hrefOf("[Done](?path=what-done-means#see-it-for-yourself)")).toBe(
      "/docs?path=what-done-means",
    );
  });

  it("resolves a bare slug against the current page", () => {
    expect(hrefOf("[Pair](pair-a-runner)")).toBe("/docs?path=pair-a-runner");
  });

  it("resolves a legacy .md link by dropping the extension", () => {
    expect(hrefOf("[Pair](./pair-a-runner.md)")).toBe("/docs?path=pair-a-runner");
  });

  it("leaves an external link pointing where it points", () => {
    expect(hrefOf("[Site](https://example.com/x?path=y)")).toBe("https://example.com/x?path=y");
  });

  it("names no page for a ?path= link with no slug, rather than guessing one", () => {
    expect(hrefOf("[Nowhere](?path=)")).toBe("/docs?path=");
  });
});

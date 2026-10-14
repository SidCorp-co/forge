// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./markdown";

expect.extend(matchers);
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

describe("a link inside the public documentation reader", () => {
  function publicHref(markdown: string): string | null {
    const { container } = render(
      <Markdown docBasePath="connect-an-assistant/cursor" docRoute="/guides">
        {markdown}
      </Markdown>,
    );
    return container.querySelector("a")?.getAttribute("href") ?? null;
  }

  it("stays on /guides instead of the sign-in-gated /docs", () => {
    expect(publicHref("[Fix](?path=connect-an-assistant/when-it-does-not-work)")).toBe(
      "/guides?path=connect-an-assistant%2Fwhen-it-does-not-work",
    );
  });

  it("resolves a bare slug against the current page's folder", () => {
    expect(publicHref("[Ask](what-you-can-ask)")).toBe(
      "/guides?path=connect-an-assistant%2Fwhat-you-can-ask",
    );
  });
});

// ISS-1289 — a help page that tells its reader to paste a block has to let them copy it first.
describe("a fenced block on a doc page", () => {
  const BLOCK = '```json\n{\n  "mcpServers": {}\n}\n```';

  it("has a Copy button that puts the block's text on the clipboard and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown variant="prose">{BLOCK}</Markdown>);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("button", { name: "Copied ✓" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('{\n  "mcpServers": {}\n}');
  });

  it("says the copy failed, rather than nothing, when the clipboard refuses", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown variant="prose">{BLOCK}</Markdown>);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("button", { name: /Couldn't copy/ })).toBeInTheDocument();
  });

  it("gives a diagram no Copy button, and an inline embed none either", () => {
    render(<Markdown variant="prose">{"```mermaid\ngraph TD; A-->B\n```"}</Markdown>);
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    cleanup();
    render(<Markdown>{BLOCK}</Markdown>);
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
});

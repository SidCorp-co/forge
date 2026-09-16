// @vitest-environment jsdom
//
// The one proposition these assert: a body's link or image is drawn against the
// origin that serves what it points at, and the same href gets the same answer
// whether the body arrived as markdown or as a parsed `format: html` tree. The
// defect they stand against is ISS-1052 — every root-relative href mapped onto
// the core origin and opened in a new tab, so an app route reached 404 JSON on
// the API host.
//
// `CORE_URL` is read off the environment at import, and with the relative
// default it is empty — which would make a core path and an app path
// indistinguishable, and every assertion below unfalsifiable. So the origin is
// set before the imports run.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "https://core.example/api";
});

import type { BodyNode } from "@forge/contracts";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BodyView } from "./body-view";
import { Markdown } from "./markdown";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("./mermaid", () => ({
  MermaidDiagram: ({ code }: { code: string }) => <pre data-testid="mermaid">{code}</pre>,
}));

const CORE = "https://core.example";

/** The same link, written both ways: `[text](href)` and `<a href>`. */
function bothLinks(href: string): [HTMLAnchorElement | null, HTMLAnchorElement | null] {
  const md = render(<Markdown>{`[go](${href})`}</Markdown>);
  const mdLink = md.container.querySelector("a");
  const html = render(
    <BodyView
      body=""
      format="html"
      nodes={[{ type: "element", name: "a", attrs: { href }, children: [{ type: "text", value: "go" }] } as BodyNode]}
    />,
  );
  return [mdLink, html.container.querySelector("a")];
}

/** The same image, written both ways: `![alt](src)` and `<img src>`. */
function bothImages(src: string): [HTMLImageElement | null, HTMLImageElement | null] {
  const md = render(<Markdown>{`![shot](${src})`}</Markdown>);
  const html = render(
    <BodyView
      body=""
      format="html"
      nodes={[{ type: "element", name: "img", attrs: { src, alt: "shot" }, children: [] } as BodyNode]}
    />,
  );
  return [md.container.querySelector("img"), html.container.querySelector("img")];
}

describe("a link in a body", () => {
  it("opens an app route on the web host, in the same tab", () => {
    for (const link of bothLinks("/projects/alpha/issues/e1c96ed2")) {
      expect(link).toHaveAttribute("href", "/projects/alpha/issues/e1c96ed2");
      expect(link).not.toHaveAttribute("target");
    }
  });

  it("opens a core file against the core, in a new tab", () => {
    for (const link of bothLinks("/api/attachments/a1/download")) {
      expect(link).toHaveAttribute("href", `${CORE}/api/attachments/a1/download`);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer noopener");
    }
  });

  it("keeps a relative core spelling on the core", () => {
    for (const link of bothLinks("./api/attachments/a1/download")) {
      expect(link).toHaveAttribute("href", `${CORE}/api/attachments/a1/download`);
    }
  });

  it("leaves an absolute URL on its own host, in a new tab", () => {
    for (const link of bothLinks("https://example.com/docs")) {
      expect(link).toHaveAttribute("href", "https://example.com/docs");
      expect(link).toHaveAttribute("target", "_blank");
    }
  });

  it("keeps an anchor on the page, in the same tab", () => {
    for (const link of bothLinks("#section")) {
      expect(link).toHaveAttribute("href", "#section");
      expect(link).not.toHaveAttribute("target");
    }
  });

  it("refuses a bare-relative path in words, and draws no link at all", () => {
    const [mdLink, htmlLink] = bothLinks("docs/guide");
    expect(mdLink).toBeNull();
    expect(htmlLink).toBeNull();
    for (const body of document.querySelectorAll("body > div")) {
      expect(body.textContent).toContain("link not shown: docs/guide");
      expect(body.textContent).toContain("belongs to neither the app nor the core");
    }
  });

  it("refuses a javascript: href rather than putting it on the page", () => {
    const [mdLink, htmlLink] = bothLinks("javascript:alert(1)");
    expect(mdLink).toBeNull();
    expect(htmlLink).toBeNull();
    expect(document.body.innerHTML).not.toContain("javascript:alert(1)\"");
  });
});

describe("an image in a body", () => {
  it("loads a root-relative static image from the web host", () => {
    for (const img of bothImages("/icon.png")) {
      expect(img).toHaveAttribute("src", "/icon.png");
    }
  });

  it("loads an absolute image from its own host", () => {
    for (const img of bothImages("https://cdn.example/image.png")) {
      expect(img).toHaveAttribute("src", "https://cdn.example/image.png");
    }
  });

  it("loads a core attachment from the core", () => {
    for (const img of bothImages("/api/attachments/a1/download")) {
      expect(img).toHaveAttribute("src", `${CORE}/api/attachments/a1/download`);
    }
  });

  it("refuses an unresolvable src in words, from the alt text", () => {
    const [mdImg, htmlImg] = bothImages("shots/one.png");
    expect(mdImg).toBeNull();
    expect(htmlImg).toBeNull();
    expect(document.body.textContent).toContain("image not shown: shots/one.png");
    expect(document.body.textContent).toContain("shot");
  });
});

describe("the Docs viewer keeps its own relative rule", () => {
  it("routes a relative doc link into the viewer rather than refusing it", () => {
    const { container } = render(
      <Markdown docBasePath="docs/guides/index.md">{"[go](pair-a-runner)"}</Markdown>,
    );
    expect(container.querySelector("a")).toHaveAttribute(
      "href",
      "/docs?path=docs%2Fguides%2Fpair-a-runner",
    );
  });
});

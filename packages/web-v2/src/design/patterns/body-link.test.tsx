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

// Each helper returns one container PER RENDERER, never a merged query and
// never `document.body`: a whole-document assertion passes on the text of
// whichever renderer got it right, which is exactly the parity failure these
// are here to catch.

/** The same link, written both ways: `[text](href)` and `<a href>`. */
function bothLinks(href: string): HTMLElement[] {
  const md = render(<Markdown>{`[go](${href})`}</Markdown>);
  const html = render(
    <BodyView
      body=""
      format="html"
      nodes={[{ type: "element", name: "a", attrs: { href }, children: [{ type: "text", value: "go" }] } as BodyNode]}
    />,
  );
  return [md.container, html.container];
}

/** The same image, written both ways: `![alt](src)` and `<img src>`. */
function bothImages(src: string): HTMLElement[] {
  const md = render(<Markdown>{`![shot](${src})`}</Markdown>);
  const html = render(
    <BodyView
      body=""
      format="html"
      nodes={[{ type: "element", name: "img", attrs: { src, alt: "shot" }, children: [] } as BodyNode]}
    />,
  );
  return [md.container, html.container];
}

describe("a link in a body", () => {
  it("opens an app route on the web host, in the same tab", () => {
    for (const at of bothLinks("/projects/alpha/issues/e1c96ed2")) {
      expect(at.querySelector("a")).toHaveAttribute("href", "/projects/alpha/issues/e1c96ed2");
      expect(at.querySelector("a")).not.toHaveAttribute("target");
    }
  });

  it("opens a core file against the core, in a new tab", () => {
    for (const at of bothLinks("/api/attachments/a1/download")) {
      const link = at.querySelector("a");
      expect(link).toHaveAttribute("href", `${CORE}/api/attachments/a1/download`);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer noopener");
    }
  });

  it("keeps a relative core spelling on the core", () => {
    for (const at of bothLinks("./api/attachments/a1/download")) {
      expect(at.querySelector("a")).toHaveAttribute("href", `${CORE}/api/attachments/a1/download`);
    }
  });

  it("leaves an absolute URL on its own host, in a new tab", () => {
    for (const at of bothLinks("https://example.com/docs")) {
      expect(at.querySelector("a")).toHaveAttribute("href", "https://example.com/docs");
      expect(at.querySelector("a")).toHaveAttribute("target", "_blank");
    }
  });

  it("keeps an anchor on the page, in the same tab", () => {
    for (const at of bothLinks("#section")) {
      expect(at.querySelector("a")).toHaveAttribute("href", "#section");
      expect(at.querySelector("a")).not.toHaveAttribute("target");
    }
  });

  it("refuses a bare-relative path in words, and draws no link at all", () => {
    for (const at of bothLinks("docs/guide")) {
      expect(at.querySelector("a")).toBeNull();
      expect(at.textContent).toContain("go");
      expect(at.textContent).toContain("link not shown: docs/guide");
      expect(at.textContent).toContain("belongs to neither the app nor the core");
    }
  });

  it("keeps a tel: link on both renderers — react-markdown's own sanitizer would drop it", () => {
    for (const at of bothLinks("tel:+4412345")) {
      expect(at.querySelector("a")).toHaveAttribute("href", "tel:+4412345");
      expect(at.querySelector("a")).toHaveAttribute("target", "_blank");
      expect(at.textContent).not.toContain("link not shown");
    }
  });

  it("keeps a mailto: link on both renderers", () => {
    for (const at of bothLinks("mailto:a@b.co")) {
      expect(at.querySelector("a")).toHaveAttribute("href", "mailto:a@b.co");
    }
  });

  it("refuses a javascript: href rather than putting it on the page", () => {
    for (const at of bothLinks("javascript:alert(1)")) {
      expect(at.querySelector("a")).toBeNull();
      expect(at.innerHTML).not.toContain('href="javascript:');
      expect(at.textContent).toContain("link not shown: javascript:alert(1)");
    }
  });

  it("keeps a query-only link on the page it is already on", () => {
    for (const at of bothLinks("?tab=history")) {
      expect(at.querySelector("a")).toHaveAttribute("href", "?tab=history");
      expect(at.querySelector("a")).not.toHaveAttribute("target");
    }
  });
});

describe("an image in a body", () => {
  it("loads a root-relative static image from the web host", () => {
    for (const at of bothImages("/icon.png")) {
      expect(at.querySelector("img")).toHaveAttribute("src", "/icon.png");
    }
  });

  it("loads an absolute image from its own host", () => {
    for (const at of bothImages("https://cdn.example/image.png")) {
      expect(at.querySelector("img")).toHaveAttribute("src", "https://cdn.example/image.png");
    }
  });

  it("loads a core attachment from the core", () => {
    for (const at of bothImages("/api/attachments/a1/download")) {
      expect(at.querySelector("img")).toHaveAttribute("src", `${CORE}/api/attachments/a1/download`);
    }
  });

  it.each(["mailto:a@b.co", "tel:+4412345"])(
    "refuses %s as an image src — it navigates to a person, not a file",
    (src) => {
      for (const at of bothImages(src)) {
        expect(at.querySelector("img")).toBeNull();
        expect(at.textContent).toContain(`image not shown: ${src}`);
        expect(at.textContent).toContain("names a person, not an image");
      }
    },
  );

  it("refuses an anchor as an image src", () => {
    for (const at of bothImages("#section")) {
      expect(at.querySelector("img")).toBeNull();
      expect(at.textContent).toContain("image not shown: #section");
      expect(at.textContent).toContain("not an image");
    }
  });

  it("refuses an unresolvable src in words, from the alt text", () => {
    for (const at of bothImages("shots/one.png")) {
      expect(at.querySelector("img")).toBeNull();
      expect(at.textContent).toContain("image not shown: shots/one.png");
      expect(at.textContent).toContain("shot");
    }
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

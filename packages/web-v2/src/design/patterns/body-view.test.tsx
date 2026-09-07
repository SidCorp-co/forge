// @vitest-environment jsdom
//
// The one proposition these assert: a component body reaches the screen as
// components. The defect they stand against is not a crash — it is `<Markdown>`
// escaping the tags and drawing `<forge-review …>` as literal text, which is
// what every issue with a component body looked like before ISS-967.

import type { BodyNode } from "@forge/contracts";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BodyView } from "./body-view";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("./mermaid", () => ({
  MermaidDiagram: ({ code }: { code: string }) => <pre data-testid="mermaid">{code}</pre>,
}));

const el = (
  name: string,
  attrs: Record<string, string>,
  children: BodyNode[] = [],
): BodyNode => ({ type: "element", name, attrs, children });
const text = (value: string): BodyNode => ({ type: "text", value });

describe("BodyView", () => {
  it("draws a component body as blocks, never as literal markup", () => {
    const nodes = [
      el("forge-review", { sha: "60e8d635", verdict: "approve" }, [
        el("forge-summary", {}, [el("p", {}, [text("ran the suite")])]),
      ]),
    ];
    render(<BodyView body="<forge-review …>" format="html" nodes={nodes} />);

    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("verdict: approve")).toBeInTheDocument();
    expect(screen.getByText("ran the suite")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("<forge-review");
  });

  it("draws a component it has never heard of the same way — the fallback card", () => {
    const nodes = [
      el("forge-from-the-future", { tone: "calm" }, [text("shipped after this build")]),
    ];
    render(<BodyView body="…" format="html" nodes={nodes} />);

    expect(screen.getByText("From the future")).toBeInTheDocument();
    expect(screen.getByText("tone: calm")).toBeInTheDocument();
    expect(screen.getByText("shipped after this build")).toBeInTheDocument();
  });

  it("hands a diagram's raw bytes to mermaid, `-->` and all", () => {
    const raw = "flowchart TB\n  A --> B<br/>C";
    render(
      <BodyView
        body="…"
        format="html"
        nodes={[el("forge-diagram", { kind: "mermaid" }, [{ type: "text", value: raw, raw: true }])]}
      />,
    );
    expect(screen.getByTestId("mermaid").textContent).toBe(raw);
  });

  it("draws an artifact through the feature's renderer when one is supplied", () => {
    render(
      <BodyView
        body="…"
        format="html"
        nodes={[el("forge-artifact", { id: "a-1" })]}
        renderArtifact={(id) => <span>artifact {id}</span>}
      />,
    );
    expect(screen.getByText("artifact a-1")).toBeInTheDocument();
  });

  it("falls back to the generic block for an artifact the caller cannot resolve", () => {
    render(<BodyView body="…" format="html" nodes={[el("forge-artifact", { id: "a-1" })]} />);
    expect(screen.getByText("Artifact")).toBeInTheDocument();
    expect(screen.getByText("id: a-1")).toBeInTheDocument();
  });

  it("renders a markdown body as markdown", () => {
    render(<BodyView body={"## Heading\n\nsome **prose**"} format="markdown" />);
    expect(screen.getByText("Heading")).toBeInTheDocument();
    expect(screen.getByText("prose")).toBeInTheDocument();
  });

  // cm:guard a component body with no tree must NOT reach `<Markdown>`: react-markdown escapes the tags and the reader sees `<forge-review …>` as text, which is the exact defect this file exists to keep out.
  it("shows the text of a body it could not parse rather than escaping its tags", () => {
    render(<BodyView body="<forge-review sha=" format="html" nodes={null} />);
    expect(screen.getByText(/Couldn't read this body/)).toBeInTheDocument();
    expect(screen.getByText("<forge-review sha=")).toBeInTheDocument();
  });

  it("unwraps a tag it has no styling for instead of dropping its prose", () => {
    render(<BodyView body="…" format="html" nodes={[el("marquee", {}, [text("kept")])]} />);
    expect(screen.getByText("kept")).toBeInTheDocument();
    expect(document.querySelector("marquee")).toBeNull();
  });

  // cm:guard the scanner accepts any `[A-Za-z][A-Za-z0-9-]*` name, so these are tags a person can really write. A bare index into the class map reaches `Object.prototype` and emits them.
  it("unwraps a tag whose name collides with Object.prototype", () => {
    render(
      <BodyView
        body="…"
        format="html"
        nodes={[el("constructor", {}, [text("still prose")]), el("tostring", {}, [text("also")])]}
      />,
    );
    expect(screen.getByText("still prose")).toBeInTheDocument();
    expect(screen.getByText("also")).toBeInTheDocument();
    expect(document.querySelector("constructor")).toBeNull();
    expect(document.querySelector("tostring")).toBeNull();
  });

  it("keeps a leaf written mid-prose where the author put it", () => {
    render(
      <BodyView
        body="…"
        format="html"
        nodes={[
          el("forge-summary", {}, [
            el("p", {}, [text("before")]),
            el("forge-artifact", { id: "a-1" }),
            el("p", {}, [text("after")]),
          ]),
        ]}
        renderArtifact={() => <span>THE ARTIFACT</span>}
      />,
    );
    const order = [...document.querySelectorAll("p, span")]
      .map((e) => e.textContent)
      .filter((t) => t === "before" || t === "after" || t === "THE ARTIFACT");
    expect(order).toEqual(["before", "THE ARTIFACT", "after"]);
  });

  // cm:edge contract -> packages/core/src/body/parse.ts — since `ad14294a` a non-raw text node holds DECODED characters. React escapes them on output, so the renderer must pass them straight through; unescaping here would double-unescape, and escaping here would print the entity.
  it("prints a decoded character as itself, not as its entity", () => {
    render(
      <BodyView
        body="…"
        format="html"
        nodes={[el("p", {}, [text('a & b, "quoted", 3 < 4')])]}
      />,
    );
    expect(screen.getByText('a & b, "quoted", 3 < 4')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("&amp;");
    expect(document.body.textContent).not.toContain("&quot;");
  });
});

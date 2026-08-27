// @vitest-environment jsdom
//
// The sandbox attribute is the only thing standing between uploaded markup and
// the session rendering it, so it is asserted rather than reviewed.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HtmlArtifact } from "./html-artifact";

expect.extend(matchers);
afterEach(cleanup);

function frame(): HTMLIFrameElement {
  return document.querySelector("iframe") as HTMLIFrameElement;
}

describe("HtmlArtifact", () => {
  it("sandboxes the frame without granting it the embedding origin", () => {
    render(<HtmlArtifact html="<p>hi</p>" title="report.html" />);
    const tokens = (frame().getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);

    expect(tokens).toContain("allow-scripts");
    expect(tokens).not.toContain("allow-same-origin");
    expect(tokens).not.toContain("allow-top-navigation");
  });

  it("passes the markup through srcdoc rather than a src the browser would fetch", () => {
    render(<HtmlArtifact html="<h1>Report</h1>" title="report.html" />);
    expect(frame().getAttribute("srcdoc")).toBe("<h1>Report</h1>");
    expect(frame().getAttribute("src")).toBeNull();
  });

  it("grows on expand and returns to the collapsed height", () => {
    render(<HtmlArtifact html="<p>hi</p>" title="report.html" height={300} />);
    expect(frame().style.height).toBe("300px");

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(frame().style.height).toBe("900px");

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(frame().style.height).toBe("300px");
  });
});

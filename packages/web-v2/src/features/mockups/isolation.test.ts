// REQ-49 BC-1: an HTML mockup runs its scripts isolated from Forge. Here, what the frame is given:
// a sandbox of scripts alone, never `allow-same-origin`, and a policy written before anything of the
// page. That a script inside then reads no cookie and reaches no API is `mockup-isolation.chrome.test.ts`.

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { MockupFrame } from "./components/mockup-preview";
import { isolatedSrcDoc, MOCKUP_CSP_META, MOCKUP_FRAME_CSP, MOCKUP_FRAME_SANDBOX } from "./isolation";

const PAGE = "<!doctype html><html><head><title>Cart</title></head><body><script>document.title='ran'</script></body></html>";

describe("the frame an HTML mockup runs in", () => {
  it("allows scripts and nothing else: never allow-same-origin", () => {
    const { getByTestId } = render(createElement(MockupFrame, { html: PAGE, title: "Cart" }));
    const frame = getByTestId("mockup-html") as HTMLIFrameElement;
    const tokens = (frame.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
    expect(tokens).toEqual(["allow-scripts"]);
    expect(tokens).not.toContain("allow-same-origin");
    expect(tokens).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("is given the page with the policy before any of it", () => {
    const { getByTestId } = render(createElement(MockupFrame, { html: PAGE, title: "Cart" }));
    const doc = getByTestId("mockup-html").getAttribute("srcdoc") ?? "";
    expect(doc.startsWith(`<!doctype html>${MOCKUP_CSP_META}<html>`)).toBe(true);
    expect(doc.endsWith(PAGE.slice("<!doctype html>".length))).toBe(true);
  });

  it("never lets a sandbox token that reopens the origin in", () => {
    expect(MOCKUP_FRAME_SANDBOX.split(/\s+/)).toEqual(["allow-scripts"]);
  });
});

describe("the policy", () => {
  const directive = (name: string) => MOCKUP_FRAME_CSP.split("; ").find((d) => d.startsWith(`${name} `));

  it("refuses every request a script makes, and anything not named", () => {
    expect(directive("default-src")).toBe("default-src 'none'");
    expect(directive("connect-src")).toBe("connect-src 'none'");
    expect(directive("form-action")).toBe("form-action 'none'");
    expect(directive("frame-src")).toBe("frame-src 'none'");
    expect(directive("img-src")).toBe("img-src data: blob:");
  });

  it("names no origin of Forge's, and never 'self'", () => {
    expect(MOCKUP_FRAME_CSP).not.toContain("'self'");
    expect(MOCKUP_FRAME_CSP).not.toMatch(/sidcorp|localhost|forge/i);
  });
});

describe("where the policy goes", () => {
  it("after a leading doctype, so the page keeps its standards mode", () => {
    expect(isolatedSrcDoc("  <!DOCTYPE html>\n<p>x</p>")).toBe(`  <!DOCTYPE html>${MOCKUP_CSP_META}\n<p>x</p>`);
  });

  it("first of all where there is no doctype, even ahead of a comment holding a head", () => {
    const page = "<!-- <head> --><head><script>1</script></head>";
    expect(isolatedSrcDoc(page)).toBe(`${MOCKUP_CSP_META}${page}`);
  });

  it("with its quotes escaped, so its content stays one attribute", () => {
    expect(MOCKUP_CSP_META).toMatch(/^<meta http-equiv="Content-Security-Policy" content="[^"]+">$/);
  });
});

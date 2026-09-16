// The origin rule, one case per branch and per boundary. `CORE_URL` is read off
// the environment at import, so the core origin is set before the import runs —
// with the relative default it is empty and a core path would be
// indistinguishable from an app path, which is a test that cannot fail.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "https://core.example/api";
});

import { describe, expect, it, vi } from "vitest";
import { classifyBodyHref } from "./body-href";
import { coreFileUrl } from "./core-url";

const CORE = "https://core.example";

describe("classifyBodyHref", () => {
  it("sends an app route to the web origin, which is the defect ISS-1052 reports", () => {
    // What the single-function renderer did before this rule existed, kept here
    // so the regression is asserted and not only described.
    expect(coreFileUrl("/projects/alpha/issues/e1c96ed2")).toBe(
      `${CORE}/projects/alpha/issues/e1c96ed2`,
    );
    expect(classifyBodyHref("/projects/alpha/issues/e1c96ed2")).toEqual({
      kind: "in-app",
      href: "/projects/alpha/issues/e1c96ed2",
    });
  });

  it("keeps a query and a fragment on an app route", () => {
    expect(classifyBodyHref("/projects/alpha/issues?status=open#top")).toEqual({
      kind: "in-app",
      href: "/projects/alpha/issues?status=open#top",
    });
  });

  it("sends a core file path to the core origin", () => {
    expect(classifyBodyHref("/api/attachments/a1/download")).toEqual({
      kind: "core-file",
      href: `${CORE}/api/attachments/a1/download`,
    });
  });

  it("treats /api itself as the core", () => {
    expect(classifyBodyHref("/api")).toEqual({ kind: "core-file", href: `${CORE}/api` });
  });

  it.each([
    ["api/attachments/a1/download", "the bare-relative spelling"],
    ["./api/attachments/a1/download", "a leading dot segment"],
    ["/./api/attachments/a1/download", "a rooted dot segment"],
    ["docs/../api/attachments/a1/download", "a popped segment"],
    ["../api/attachments/a1/download", "a pop at root"],
    ["%2e/api/attachments/a1/download", "a percent-encoded dot"],
    ["docs/%2e%2e/api/attachments/a1/download", "percent-encoded double dots"],
  ])("resolves %s against the core (%s)", (href) => {
    expect(classifyBodyHref(href)).toEqual({
      kind: "core-file",
      href: `${CORE}/api/attachments/a1/download`,
    });
  });

  it.each(["/apiary/logo.png", "/api-v2/file", "/apiv2/file"])(
    "does not send %s to the core — the boundary is the segment, not the letters",
    (href) => {
      expect(classifyBodyHref(href)).toEqual({ kind: "in-app", href });
    },
  );

  it("leaves an escaped separator escaped, so %2fapi is not the core", () => {
    const answer = classifyBodyHref("%2fapi/logo.png");
    expect(answer.kind).toBe("unresolvable");
    expect(answer.href).toBe("%2fapi/logo.png");
  });

  it.each(["https://example.com/x", "http://example.com/x", "mailto:a@b.co", "tel:+4412345"])(
    "passes %s through untouched",
    (href) => {
      expect(classifyBodyHref(href)).toEqual({ kind: "external", href });
    },
  );

  it("treats a protocol-relative URL as external", () => {
    expect(classifyBodyHref("//cdn.example.com/x.png")).toEqual({
      kind: "external",
      href: "//cdn.example.com/x.png",
    });
  });

  it("keeps an anchor on the page", () => {
    expect(classifyBodyHref("#section")).toEqual({ kind: "anchor", href: "#section" });
  });

  it.each(["javascript:alert(1)", "data:text/html,<b>x", "vbscript:msgbox", "file:///etc/passwd"])(
    "refuses %s rather than rendering it",
    (href) => {
      const answer = classifyBodyHref(href);
      expect(answer.kind).toBe("unresolvable");
      expect(answer).toMatchObject({ reason: expect.stringContaining("not opened") });
    },
  );

  it("refuses a bare-relative path that names neither origin", () => {
    const answer = classifyBodyHref("docs/guide");
    expect(answer.kind).toBe("unresolvable");
    expect(answer).toMatchObject({
      reason: "a relative path here belongs to neither the app nor the core",
    });
  });

  it("refuses an empty href", () => {
    expect(classifyBodyHref("")).toEqual({
      kind: "unresolvable",
      href: "",
      reason: "the link has no target",
    });
  });
});

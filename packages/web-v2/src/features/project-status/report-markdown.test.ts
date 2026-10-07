import { describe, expect, it } from "vitest";
import { labelCopy } from "@/lib/i18n/labels";
import { productCopy } from "@/lib/i18n/product-copy";
import { statusMarkdown } from "./report-markdown";
import { AT, STATUS } from "./status-fixture";

// JU-4: no surface could be copied, printed or sent; the report copies as Markdown in the reader's
// language, dated, every section stamped, and a row waiting on the viewer names them for its reader.

const words = (lang: "en" | "vi") => ({ t: productCopy(lang), label: labelCopy(lang), clock: { lang, now: Date.parse(AT), timeZone: "UTC" } });

describe("the status report as Markdown", () => {
  it("reads every section in order, dated, in English", () => {
    expect(statusMarkdown(STATUS, words("en"))).toMatchSnapshot();
  });

  it("reads the same report in Vietnamese", () => {
    expect(statusMarkdown(STATUS, words("vi"))).toMatchSnapshot();
  });

  it("names the viewer where a row waits on them, since the reader of a pasted report is someone else", () => {
    const md = statusMarkdown(STATUS, words("en"));
    expect(md).toContain("**0.3.0** Release 0.3.0 — Lan — approve the release");
    expect(md).not.toMatch(/— You —/);
  });

  it("says what each shipped release verified and dates each section", () => {
    const md = statusMarkdown(STATUS, words("en"));
    expect(md).toContain("Partly verified: 1 of 2 criteria proven, and the deploy checked by the production probes");
    expect(md.match(/_read /g)).toHaveLength(7);
  });

  it("says plainly when nothing shipped in the window", () => {
    const quiet = { ...STATUS, shipped: { ...STATUS.shipped, releases: [], releaseCount: 0, issueCount: 0, requirementsShipped: [] } };
    expect(statusMarkdown(quiet, words("en"))).toContain("Nothing reached users in the last 7 days.");
  });
});

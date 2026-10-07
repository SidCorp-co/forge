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

  it("calls a harness report by the area it waits in, never by the id no reader knows", () => {
    const id = "b4e9546d-5dad-4dec-b7c6-9a0becf852c0";
    const report = { area: "automation" as const, entity: "report" as const, key: id, title: "Harness run failed", touchedAt: AT, waitingOn: { kind: "writers" as const, who: "Harness triage", act: "triage a report", rule: "", ref: null, dueAt: null } };
    const md = statusMarkdown({ ...STATUS, waits: { ...STATUS.waits, people: [report], peopleCount: 1 } }, words("en"));
    expect(md).not.toContain(id);
    expect(md).toContain(`**${labelCopy("en")("needsYouArea", "automation")}** Harness run failed`);
  });

  it("says what each shipped release verified and dates each section", () => {
    const md = statusMarkdown(STATUS, words("en"));
    expect(md).toContain("Partly verified: 1 of 2 criteria proven, and the deploy checked by the production probes");
    expect(md.match(/_read /g)).toHaveLength(7);
  });

  it("names a release already cut as the next one, its state and whose turn, and the draft behind it", () => {
    const cut = {
      ...STATUS.nextRelease,
      version: "0.3.0",
      state: "awaiting_approval" as const,
      progress: { total: 26, shipped: 0, awaitingRelease: 26, toDo: 0 },
      turn: { who: "Lan", act: "approve 0.3.0" },
      behind: { version: "0.4.0", issueCount: 2 },
    };
    const md = statusMarkdown({ ...STATUS, nextRelease: cut }, words("en"));
    expect(md).toContain(`**0.3.0** · ${labelCopy("en")("releaseState", "awaiting_approval")} · 0 shipped · 26 landed, awaiting release · 0 to do · Lan — approve 0.3.0 · draft 0.4.0 waits behind it with 2 issues`);
  });

  it("says plainly when nothing shipped in the window", () => {
    const quiet = { ...STATUS, shipped: { ...STATUS.shipped, releases: [], releaseCount: 0, issueCount: 0, requirementsShipped: [] } };
    expect(statusMarkdown(quiet, words("en"))).toContain("Nothing reached users in the last 7 days.");
  });
});

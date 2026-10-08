// JU-2: hop REQ-19 read "Issues done 0/6" on the requirements list and "5/6 landed" on Releases, and
// both said "xong" in Vietnamese. Both pages now print core's one progress — shipped, landed awaiting
// release, to do — through one function, and the Vietnamese words for landed and shipped differ.

import type { ComingNextForecast, RequirementForecasts, ScopeForecast } from "@forge/contracts/forecast";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComingNext } from "@/features/releases/components/coming-next";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { PRODUCT_STRINGS as product } from "@/lib/i18n/product-copy";
import { REQ_PROJECT, reqQueries, Seeded } from "@/test/vi-chrome-requirements";
import { RequirementsScreen } from "./requirements-screen";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/" }));
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

const stamp = { label: "forecast" as const, asOf: "2026-10-07T12:00:00Z" };
const REQ_19: ScopeForecast = {
  ...stamp,
  scope: "requirement", anchor: { at: "2026-10-07T00:00:00.000Z", event: { key: "forecast.event.none" } }, moved: null,
  key: "REQ-1",
  title: "Muc",
  progress: { total: 6, shipped: 0, awaitingRelease: 5, toDo: 1 },
  forecast: null,
  next: null,
  delivery: null,
};
const forecasts: RequirementForecasts = { ...stamp, projectId: REQ_PROJECT, requirements: [REQ_19] };
const coming: ComingNextForecast = { ...stamp, projectId: REQ_PROJECT, requirements: [REQ_19], draft: null } as unknown as ComingNextForecast;
const clock = { lang: "vi" as const, now: Date.parse(stamp.asOf), timeZone: "UTC" };

function listText(language: "en" | "vi"): string {
  const { container, unmount } = render(
    <InterfaceLanguageScope language={language}>
      <Seeded data={[...reqQueries(), [["issues", "standing", "forecast", "requirements", REQ_PROJECT], forecasts]]}>
        <RequirementsScreen projectId={REQ_PROJECT} slug="hop" />
      </Seeded>
    </InterfaceLanguageScope>,
  );
  const text = container.textContent ?? "";
  unmount();
  return text;
}

function releasesText(language: "en" | "vi"): string {
  const { unmount } = render(
    <InterfaceLanguageScope language={language}>
      <ComingNext next={coming} draft={undefined} slug="hop" clock={clock} />
    </InterfaceLanguageScope>,
  );
  const row = screen.getByTestId("coming-next-requirement");
  const text = within(row).getByTestId("issue-progress").textContent ?? "";
  unmount();
  return text;
}

describe("one progress on the requirements list and on Releases", () => {
  it.each(["en", "vi"] as const)("prints REQ-19 the same on both pages in %s", (language) => {
    const releases = releasesText(language);
    expect(releases).toBe(language === "en" ? "0 shipped · 5 landed, awaiting release · 1 to do" : "0 đã phát hành · 5 xong code, chờ release · 1 còn lại"); // i18n-allow: asserts the vi progress copy
    expect(listText(language)).toContain(releases);
  });
});

describe("the progress words", () => {
  const vi_ = product.vi as Record<string, string>;
  const en = product.en as Record<string, string>;

  it("gives shipped, landed and to do three different Vietnamese words, and only landed uses the landed word", () => {
    const words = ["progress.shipped", "progress.awaitingRelease", "progress.toDo"].map((k) => vi_[k]?.replace("{n} ", ""));
    expect(new Set(words).size).toBe(3);
    expect(words.filter((w) => w?.includes("xong"))).toEqual(["xong code, chờ release"]); // i18n-allow: asserts the vi progress copy
  });

  it("never says the landed word where English says shipped, nor the shipped word where English says landed", () => {
    // a sentence that names one of the two states; one that sets them side by side (the hint) names both
    const only = (one: RegExp, other: RegExp) => Object.keys(en).filter((k) => one.test(en[k] ?? "") && !other.test(en[k] ?? ""));
    const SHIPPED = /\bshipped\b/i;
    const LANDED = /\blanded\b/i;
    expect(only(SHIPPED, LANDED).filter((k) => vi_[k]?.includes("xong"))).toEqual([]);
    expect(only(LANDED, SHIPPED).filter((k) => vi_[k]?.includes("phát hành"))).toEqual([]); // i18n-allow: the vi word for shipped
  });

  it("keeps no count that called closed issues done", () => {
    for (const k of ["requirements.row.issuesDone", "requirements.facts.doneOf", "releases.landedOf", "fc.scopeHead", "standing.act.done"]) {
      expect(en[k]).toBeUndefined();
      expect(vi_[k]).toBeUndefined();
    }
  });
});

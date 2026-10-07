import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { StepBar } from "./facts-rail";

// A step's name is read whole, at a 1440px rail and at a 390px phone alike: in a fifth of a 280px
// rail the Vietnamese "triaged" does not fit one line, so the label wraps onto a second line by design
// and is never cut to its first word. jsdom lays nothing out, so the rule is asserted on the label itself: no
// ellipsis, no forced single line, no clipping, and a break allowed anywhere a long word needs one.

const CUTS = ["truncate", "text-ellipsis", "whitespace-nowrap", "overflow-hidden", "line-clamp"];

const steps = [
  { key: "new", label: "Mới", state: "done" as const }, // i18n-allow: the vi step names whose width the rule is about
  { key: "triaged", label: "Đã phân loại", state: "done" as const }, // i18n-allow: the vi step names whose width the rule is about
  { key: "planned", label: "Đã lên kế hoạch", state: "now" as const, meta: "1 giờ 26 phút" }, // i18n-allow: the vi step names whose width the rule is about
  { key: "resolved", label: "Đã xử lý", state: "next" as const }, // i18n-allow: the vi step names whose width the rule is about
  { key: "verified", label: "Đã xác nhận", state: "next" as const }, // i18n-allow: the vi step names whose width the rule is about
];

describe("the step bar's labels", () => {
  it("wraps a long Vietnamese step name instead of cutting it", () => {
    const { container } = render(
      <InterfaceLanguageScope language="vi">
        <StepBar steps={steps} />
      </InterfaceLanguageScope>,
    );
    const items = [...container.querySelectorAll('[data-testid="step-bar"] li')];
    expect(items).toHaveLength(steps.length);
    for (const [i, li] of items.entries()) {
      const texts = [...li.querySelectorAll("span")].filter((s) => s.textContent);
      expect(texts[0]?.textContent, "the label reads whole").toBe(steps[i]?.label);
      for (const span of texts) {
        const cls = span.className;
        for (const cut of CUTS) expect(cls, `"${span.textContent}" is cut by ${cut}`).not.toContain(cut);
        expect(cls, `"${span.textContent}" may break where a long word needs it`).toContain("[overflow-wrap:anywhere]");
      }
    }
  });
});

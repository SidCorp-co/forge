// A wide screen for a detail page under test. DetailLayout reads whether its rail stands beside the
// content from a probe that only the `lg` step hides; jsdom loads no CSS, so without this every test
// renders the phone layout, where the rail is folded behind Facts.

import { vi } from "vitest";

export function railBeside() {
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const style = real(el, pseudo);
    return el instanceof HTMLElement && el.dataset.testid === "rail-probe" ? { ...style, display: "none" } : style;
  });
}

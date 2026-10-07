import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { CHROME_SCREENS, type ChromeScreen } from "./vi-chrome-screens";
import { renderWithQuery } from "./render";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/" }));

// Words that are English chrome and have a Vietnamese word in the locale file. A screen rendered in vi
// that still shows one of them has a string that never went through the locale file. Brand and
// product terms the vi copy keeps (Release, Workflow, Issue, Runner, Master) are not on the list.
const ENGLISH_CHROME = [
  "needs you", "nothing", "waiting", "lands", "late", "progress", "requirements", "untriaged", "overview", "dashboard", "settings",
  "sign out", "next release", "open full page", "show", "hide", "close", "cancel", "loading", "failed", "couldn't", "no ", "search",
  "waits on", "then", "forecast", "landed", "shipped", "feedback about",
];

const wordsIn = (root: HTMLElement): string[] => {
  const out: string[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n.textContent ?? "");
  for (const el of root.querySelectorAll("[aria-label],[title],[placeholder]")) {
    for (const a of ["aria-label", "title", "placeholder"]) {
      const v = el.getAttribute(a);
      if (v) out.push(v);
    }
  }
  return out;
};

/** The English chrome word found in a rendered screen, with the text carrying it; null when none. */
function englishChromeIn(root: HTMLElement): { word: string; text: string } | null {
  for (const text of wordsIn(root)) {
    const lower = ` ${text.toLowerCase()} `;
    for (const w of ENGLISH_CHROME) {
      if (new RegExp(`[^\\p{L}]${w.trim()}[^\\p{L}]`, "u").test(lower)) return { word: w.trim(), text };
    }
  }
  return null;
}

const inVi = (s: ChromeScreen) => (
  <InterfaceLanguageScope language="vi">{s.render()}</InterfaceLanguageScope>
);

describe("BA screens under vi", () => {
  for (const screen of CHROME_SCREENS) {
    it(`${screen.name} shows no English chrome word`, () => {
      const { container } = renderWithQuery(inVi(screen));
      const found = englishChromeIn(container);
      expect(found, found ? `English chrome word "${found.word}" on screen "${screen.name}": "${found.text}"` : "").toBeNull();
    });
  }

  it("goes red, naming the word and the screen, on an English string planted in the Dashboard", () => {
    const planted: ChromeScreen = { name: "Dashboard", render: () => <p>Nothing to show here</p> };
    const { container } = render(inVi(planted));
    const found = englishChromeIn(container);
    expect(found?.word).toBe("nothing");
    expect(`English chrome word "${found?.word}" on screen "${planted.name}"`).toContain('on screen "Dashboard"');
  });
});

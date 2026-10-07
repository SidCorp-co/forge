import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { englishChromeWord } from "./english-chrome";
import { CHROME_SCREENS, type ChromeScreen } from "./vi-chrome-screens";
import { renderWithQuery } from "./render";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({ slug: "hop" }) }));
// The bell's live delivery and a room's socket reach for a connection the walking test has none of.
vi.mock("@/features/notifications/use-notification-delivery", () => ({ useNotificationDelivery: () => undefined }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
// The canvas itself is drawn by React Flow, which jsdom cannot lay out; its chrome is rendered on its own ("Workflow canvas").
vi.mock("@/features/workflows/canvas/workflow-canvas", () => ({ WorkflowCanvas: () => null }));
// A query no screen was seeded with stays pending rather than reaching for a network.
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
// cmdk scrolls its selected item into view, which jsdom does not lay out
Element.prototype.scrollIntoView = () => {};

const wordsIn = (root: HTMLElement): string[] => {
  const out: string[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  // text the page marks `translate="no"` (a scope, an event name, another product's menu path) is an identifier, not chrome
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (!n.parentElement?.closest('[translate="no"]')) out.push(n.textContent ?? "");
  for (const el of root.querySelectorAll("[aria-label],[title],[placeholder]")) {
    if (el.closest('[translate="no"]')) continue;
    for (const a of ["aria-label", "title", "placeholder"]) {
      const v = el.getAttribute(a);
      // a state badge's tooltip leads with its raw value (`shipped · ...`) and an enum badge's ends with
      // it (`kind: bug`), kept in English on purpose: the field word and the meaning are what is read
      const raw = el.getAttribute("data-value");
      const read = a !== "title" || !raw ? v : v === raw ? null : v?.startsWith(`${raw} · `) ? v.slice(raw.length + 3) : v?.endsWith(`: ${raw}`) ? v.slice(0, -raw.length - 2) : v;
      if (read) out.push(read);
    }
  }
  return out;
};

/** The English chrome word found in a rendered screen, with the text carrying it; null when none. */
function englishChromeIn(root: HTMLElement): { word: string; text: string } | null {
  for (const text of wordsIn(root)) {
    const word = englishChromeWord(text);
    if (word) return { word, text };
  }
  return null;
}

const inVi = (s: ChromeScreen) => (
  <InterfaceLanguageScope language="vi">{s.render()}</InterfaceLanguageScope>
);

describe("BA screens under vi", () => {
  for (const screen of CHROME_SCREENS) {
    it(`${screen.name} shows no English chrome word`, () => {
      // the whole document: a menu, a popover or a dialog the screen opens is drawn in a portal
      const { baseElement } = renderWithQuery(inVi(screen));
      if (screen.act) act(screen.act);
      const found = englishChromeIn(baseElement);
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

/** The rail's row labels of a screen drawn in `language`, in the order they stand. */
function factLabels(screen: ChromeScreen, language: "en" | "vi"): string[] {
  const { baseElement, unmount } = renderWithQuery(<InterfaceLanguageScope language={language}>{screen.render()}</InterfaceLanguageScope>);
  if (screen.act) act(screen.act);
  const labels = [...baseElement.querySelectorAll("[data-fact-label]")].map((el) => el.textContent?.trim() ?? "");
  unmount();
  return labels;
}

/** Two rows whose English labels differ and whose Vietnamese ones are the same word: the reader cannot tell them apart. */
function collapsedLabels(en: string[], vi: string[]): { vi: string; en: [string, string] } | null {
  for (let i = 0; i < vi.length; i++) {
    for (let j = i + 1; j < vi.length; j++) {
      if (vi[i] === vi[j] && en[i] !== en[j]) return { vi: vi[i] as string, en: [en[i] as string, en[j] as string] };
    }
  }
  return null;
}

describe("a rail's row labels under vi", () => {
  for (const screen of CHROME_SCREENS) {
    it(`${screen.name}: two rows with different English labels never read as one Vietnamese word`, () => {
      const en = factLabels(screen, "en");
      const vi = factLabels(screen, "vi");
      expect(vi.length, `${screen.name} draws ${en.length} rows in en and ${vi.length} in vi`).toBe(en.length);
      const hit = collapsedLabels(en, vi);
      expect(hit, hit ? `"${hit.en[0]}" and "${hit.en[1]}" both read "${hit.vi}" on screen "${screen.name}"` : "").toBeNull();
    });
  }

  it("goes red on two rows whose different English labels share one Vietnamese word", () => {
    expect(collapsedLabels(["ETA", "Forecast"], ["Dự kiến", "Dự kiến"])).toEqual({ vi: "Dự kiến", en: ["ETA", "Forecast"] }); // i18n-allow: the planted collision pair
    expect(collapsedLabels(["State", "State"], ["Trạng thái", "Trạng thái"])).toBeNull(); // i18n-allow: one English label read twice is no collision
  });
});

import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { CHROME_SCREENS, type ChromeScreen } from "./vi-chrome-screens";
import { renderWithQuery } from "./render";
import { unreadIn } from "./unread";

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

const inVi = (s: ChromeScreen) => (
  <InterfaceLanguageScope language="vi">{s.render()}</InterfaceLanguageScope>
);

// Forge is not multilingual (the owner's ruling of 2026-10-08): a vi page may show English, so what
// this walks for is what no reader can read, in any language. Which words are English is not asked.
describe("BA screens under vi", () => {
  for (const screen of CHROME_SCREENS) {
    it(`${screen.name} renders, with no raw copy key and no blank label`, () => {
      // the whole document: a menu, a popover or a dialog the screen opens is drawn in a portal
      const { baseElement } = renderWithQuery(inVi(screen));
      if (screen.act) act(screen.act);
      expect(baseElement.textContent?.trim(), `screen "${screen.name}" drew no words`).toBeTruthy();
      const found = unreadIn(baseElement);
      expect(found, found ? `${found} on screen "${screen.name}"` : "").toBeNull();
    });
  }

  it("goes red, naming what it found, on a raw key, an unknown key's marker and a blank label planted in a screen", () => {
    const planted = (ui: ReactElement) => unreadIn(render(<InterfaceLanguageScope language="vi">{ui}</InterfaceLanguageScope>).container);
    expect(planted(<p> dash.fbUntriaged </p>)).toBe('the raw copy key "dash.fbUntriaged"');
    expect(planted(<code translate="no">releases.approve</code>)).toBeNull();
    expect(planted(<p>⟦standing.act.noSuchAct⟧</p>)).toBe('a key this build lacks, "⟦standing.act.noSuchAct⟧"');
    expect(planted(<button type="button" aria-label=" " />)).toBe("a blank aria-label on <button>");
    expect(planted(<input title="dash.fbOpen" />)).toBe('the raw copy key "dash.fbOpen" (title)');
    expect(planted(<span data-fact-label />)).toBe("a blank fact label");
    expect(planted(<p>Nothing to show here</p>)).toBeNull();
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

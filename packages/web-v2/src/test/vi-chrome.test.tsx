import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { gatherScreens } from "./vi-chrome-screens";
import { renderWithQuery } from "./render";
import { unreadIn } from "./unread";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({ slug: "hop" }) }));
// The bell's live delivery and a room's socket reach for a connection the walking test has none of.
vi.mock("@/features/notifications/use-notification-delivery", () => ({ useNotificationDelivery: () => undefined }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
// The canvas itself is drawn by React Flow, which jsdom cannot lay out; its chrome is rendered on its own ("Workflow canvas").
vi.mock("@/features/workflows/canvas/workflow-canvas", () => ({ WorkflowCanvas: () => null }));
// A query no screen was seeded with stays pending rather than reaching for a network.
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
// cmdk scrolls its selected item into view, which jsdom does not lay out
Element.prototype.scrollIntoView = () => {};

// The glob sits in this file, not in vi-chrome-screens.tsx: vite expands it into imports of this
// test, so a change to one screen file selects this test (ISS-134).
const CHROME_SCREENS = gatherScreens(
  import.meta.glob(["./vi-chrome-*.tsx", "!./vi-chrome-screens.tsx"], { eager: true, import: "SCREENS" }),
);

// Forge is English only (the owner's ruling of 2026-10-08): this walks for what no reader can read,
// a raw key or a blank label, on every screen. The files keep their `vi-chrome-` names because the
// record-page witness globs them by that name.
describe("BA screens in English", () => {
  for (const screen of CHROME_SCREENS) {
    it(`${screen.name} renders, with no raw copy key and no blank label`, () => {
      // the whole document: a menu, a popover or a dialog the screen opens is drawn in a portal
      const { baseElement } = renderWithQuery(screen.render());
      if (screen.act) act(screen.act);
      expect(baseElement.textContent?.trim(), `screen "${screen.name}" drew no words`).toBeTruthy();
      const found = unreadIn(baseElement);
      expect(found, found ? `${found} on screen "${screen.name}"` : "").toBeNull();
    });
  }

  it("goes red, naming what it found, on a raw key, an unknown key's marker and a blank label planted in a screen", () => {
    const planted = (ui: ReactElement) => unreadIn(render(ui).container);
    expect(planted(<p> dash.fbUntriaged </p>)).toBe('the raw copy key "dash.fbUntriaged"');
    expect(planted(<code translate="no">releases.approve</code>)).toBeNull();
    expect(planted(<p>⟦standing.act.noSuchAct⟧</p>)).toBe('a key this build lacks, "⟦standing.act.noSuchAct⟧"');
    expect(planted(<button type="button" aria-label=" " />)).toBe("a blank aria-label on <button>");
    expect(planted(<input title="dash.fbOpen" />)).toBe('the raw copy key "dash.fbOpen" (title)');
    expect(planted(<span data-fact-label />)).toBe("a blank fact label");
    expect(planted(<p>Nothing to show here</p>)).toBeNull();
  });
});

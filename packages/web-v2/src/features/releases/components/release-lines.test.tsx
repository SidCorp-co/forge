// ISS-1308, mockup MK-13: a release opens on a hero with its counts and cover clip; each What's new
// line shows the clip or shots its judge marked in a desktop and a phone frame, with a toggle, a play
// mark with its length and a lightbox; a Fixed line with no screen says so; and the developer view
// counts the lines that touched a screen and show nothing.
// @direct-test-of packages/web-v2/src/features/releases/components/release-visual.tsx
// @direct-test-of packages/web-v2/src/design/patterns/device-frame.tsx

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releasePage } from "@/test/release-page";
import { rawKeysOnFace } from "@/test/screen-face";
import { FixedRows, ReleaseHero, VisualsOwed, WhatsNew } from "./release-lines";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("png", { status: 200 }))));
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
});
afterEach(() => vi.unstubAllGlobals());

describe("a release opens on its hero (ISS-1308)", () => {
  it("names the release, says its summary and counts its lines, criteria, clips and shots", () => {
    render(<ReleaseHero page={releasePage()} authed />);
    const hero = screen.getByTestId("release-hero");
    expect(hero).toHaveTextContent("Readable releases");
    expect(screen.getByTestId("hero-new")).toHaveTextContent("1New");
    expect(screen.getByTestId("hero-fixed")).toHaveTextContent("1Fixed");
    expect(screen.getByTestId("hero-criteria")).toHaveTextContent("2/3Criteria passed");
    expect(screen.getByTestId("hero-media")).toHaveTextContent("1 · 1Clips · shots");
    // the cover is the line's clip, on its still, with its length
    expect(within(screen.getByTestId("hero-cover")).getByTestId("visual-play")).toHaveTextContent("Watch 0:20");
  });

  it("draws no cover where no line shows anything", () => {
    const page = releasePage();
    render(<ReleaseHero page={{ ...page, improvements: page.improvements.map((c) => ({ ...c, visual: null })) }} authed />);
    expect(screen.queryByTestId("hero-cover")).toBeNull();
    expect(screen.queryByTestId("hero-media")).toBeNull();
  });
});

describe("each What's new line shows its judge's clip and shots (ISS-1308)", () => {
  it("sets the phone frame beside the desktop one, toggles to the phone alone, and opens the clip large", async () => {
    const { container } = render(<WhatsNew page={releasePage()} authed />);
    const row = screen.getByTestId("whats-new-row");
    expect(row).toHaveAttribute("data-visual", "shown");
    expect(screen.getAllByTestId("visual-frame").map((f) => f.dataset.kind)).toEqual(["clip", "picture"]);
    expect(screen.getByTestId("visual-play")).toHaveTextContent("0:20");
    fireEvent.click(screen.getByRole("button", { name: "Phone" }));
    expect(screen.getByTestId("line-visual")).toHaveAttribute("data-frame", "phone");
    expect(screen.getAllByTestId("visual-frame").map((f) => f.dataset.kind)).toEqual(["picture"]);
    fireEvent.click(screen.getByRole("button", { name: "Desktop" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Releases read as pages" }));
    expect(await screen.findByTestId("visual-lightbox")).toBeTruthy();
    expect(rawKeysOnFace(container)).toEqual([]);
  });

  it("shows a line with nothing marked as its words alone", () => {
    const page = releasePage();
    render(<WhatsNew page={{ ...page, improvements: page.improvements.map((c) => ({ ...c, visual: null })) }} authed />);
    expect(screen.getByTestId("whats-new-row")).toHaveAttribute("data-visual", "none");
    expect(screen.queryByTestId("visual-frame")).toBeNull();
  });
});

describe("Fixed reads as compact rows (ISS-1308)", () => {
  it("says No UI for a line whose landing touched no screen, and leaves a ui line's slot blank", () => {
    const page = releasePage();
    const fixes = [page.fixes[0], { ...page.fixes[0], issueKey: "ISS-3", line: "Menus line up.", ui: true }].filter((c) => c !== undefined);
    render(<FixedRows page={{ ...page, fixes }} authed />);
    const slots = screen.getAllByTestId("fixed-thumb-none");
    expect(slots.map((s) => [s.dataset.ui, s.textContent])).toEqual([
      ["false", "No UI"],
      ["true", "—"],
    ]);
  });
});

describe("the developer view counts the visuals owed, and refuses nothing (ISS-1308 c4)", () => {
  it("lists each ui line with no visual under its count", () => {
    const page = releasePage({ visualsOwed: { count: 1, lines: [{ issueKey: "ISS-3", line: "Menus line up.", kind: "fixed" }] } });
    render(<VisualsOwed page={page} />);
    expect(screen.getByTestId("visuals-owed")).toHaveAttribute("data-count", "1");
    expect(screen.getByTestId("visual-owed-row")).toHaveTextContent("Menus line up.Visual owed");
  });

  it("draws nothing where none is owed, and on the user view", () => {
    const { container } = render(<VisualsOwed page={releasePage({ visualsOwed: { count: 0, lines: [] } })} />);
    render(<VisualsOwed page={releasePage()} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("visuals-owed")).toBeNull();
  });
});

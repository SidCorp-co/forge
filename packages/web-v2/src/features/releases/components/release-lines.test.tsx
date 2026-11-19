// ISS-1308, mockup MK-13: a release opens on a hero with its counts and cover clip; each What's new
// line shows the clip or shots its judge marked in a desktop and a phone frame, with a toggle, a play
// mark with its length and a lightbox; a Fixed line with no screen says so; and the developer view
// counts the lines that touched a screen and show nothing.
// @direct-test-of packages/web-v2/src/features/releases/components/release-visual.tsx
// @direct-test-of packages/web-v2/src/design/patterns/device-frame.tsx
// ISS-1368: a row's sentence opens on demand under its title, never on hover alone
// @direct-test-of packages/web-v2/src/features/releases/components/release-report.tsx
// @direct-test-of packages/web-v2/src/features/releases/components/release-bits.tsx

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releasePage } from "@/test/release-page";
import { rawKeysOnFace } from "@/test/screen-face";
import { FixedRows, ReleaseHero, VisualsOwed, WhatsNew } from "./release-lines";
import { NeedsAttention } from "./release-report";

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
  it("writes a clip of an hour or more as h:mm:ss", () => {
    const page = releasePage();
    render(<WhatsNew page={{ ...page, improvements: page.improvements.map((c) => ({ ...c, visual: c.visual && { ...c.visual, seconds: 3600 } })) }} authed />);
    expect(screen.getByTestId("visual-play")).toHaveTextContent("1:00:00");
  });

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

describe("a row's sentence opens on demand under its title, never on hover alone (ISS-1368)", () => {
  const SENTENCE = "Open any release and read what it brings, whole, in under a minute.";
  const FIXED = "Dates no longer slip a day across time zones.";
  /** No element of the page carries a sentence in a hover-only title. */
  const onHover = (root: HTMLElement, text: string) => [...root.querySelectorAll("[title]")].filter((e) => e.getAttribute("title") === text);

  it("shows a What's new row's title shut, and opens its sentence whole on a click, and shuts it again", () => {
    const { container } = render(<WhatsNew page={releasePage()} authed />);
    const toggle = screen.getByRole("button", { name: "Releases read as pages" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(screen.getByRole("heading", { level: 3 })).getByRole("button")).toBe(toggle);
    expect(screen.queryByText(SENTENCE)).toBeNull();
    expect(onHover(container, SENTENCE)).toEqual([]);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const sentence = screen.getByTestId("whats-new-detail");
    expect(sentence).toHaveTextContent(SENTENCE);
    expect(toggle).toHaveAttribute("aria-controls", sentence.id);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("whats-new-detail")).toBeNull();
  });

  it("opens a What's new row's sentence from the keyboard, by Enter and by Space", async () => {
    const user = userEvent.setup();
    render(<WhatsNew page={releasePage()} authed />);
    await user.tab();
    const toggle = screen.getByRole("button", { name: "Releases read as pages" });
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("whats-new-detail")).toHaveTextContent(SENTENCE);
    await user.keyboard(" ");
    expect(screen.queryByTestId("whats-new-detail")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a Fixed row's sentence the same way, where it showed on hover alone before", async () => {
    const user = userEvent.setup();
    const page = releasePage();
    const fixes = page.fixes.map((c) => ({ ...c, detail: FIXED }));
    const { container } = render(<FixedRows page={{ ...page, fixes }} authed />);
    expect(onHover(container, FIXED)).toEqual([]);
    const toggle = screen.getByRole("button", { name: "Dates show correctly." });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(FIXED)).toBeNull();
    await user.click(toggle);
    expect(screen.getByTestId("fixed-detail")).toHaveTextContent(FIXED);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("draws a row with no sentence as its title alone, with nothing to open", () => {
    const page = releasePage();
    render(<WhatsNew page={{ ...page, improvements: page.improvements.map((c) => ({ ...c, detail: null })) }} authed />);
    render(<FixedRows page={page} authed />);
    expect(screen.getByRole("heading", { level: 3, name: "Releases read as pages" })).toBeTruthy();
    expect(screen.getByTestId("fixed-row")).toHaveTextContent("Dates show correctly.");
    expect(screen.queryByTestId("whats-new-toggle")).toBeNull();
    expect(screen.queryByTestId("fixed-toggle")).toBeNull();
  });

  it("opens a Needs attention line's reason the same way, never on hover", async () => {
    const user = userEvent.setup();
    const page = releasePage();
    const { container } = render(<NeedsAttention page={{ ...page, header: { ...page.header, recordedNotCut: true } }} />);
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
    const toggle = screen.getByTestId("page-attention-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByTestId("page-attention-detail").textContent).not.toBe("");
  });
});

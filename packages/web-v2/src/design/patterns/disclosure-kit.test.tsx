// The disclosure kit (REQ-11 BC-22): a screen's face is a name, a status and one next action, and
// everything else opens on demand. Each block is pinned on its happy path, its keyboard, its empty
// state and its shut and open states: a fact that is shut is not in the document at all, so neither
// the word-budget test nor a reader meets it until it is asked for.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandPalette } from "./command-palette";
import { CountSection } from "./count-section";
import { DetailDrawer } from "./detail-drawer";
import { ExpandRow, ExpandRows } from "./expand-row";
import { NextAction } from "./next-action";
import { PageCommandsProvider, usePageCommandList, usePageCommands } from "./page-commands";
import { StatusChip } from "./status-chip";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());
// cm:why cmdk scrolls the selected item into view, and jsdom has no layout to scroll
Element.prototype.scrollIntoView = () => {};

function Runs({ onOpenChange }: { onOpenChange?: (id: string | null) => void }) {
  return (
    <ExpandRows label="Runs" onOpenChange={onOpenChange}>
      {["Build", "Test", "Ship"].map((name) => (
        <ExpandRow key={name} id={name} head={<span>{name}</span>} trail={<button type="button">Stop {name}</button>}>
          <p>{name} detail</p>
        </ExpandRow>
      ))}
    </ExpandRows>
  );
}

const heads = () => screen.getAllByRole("button", { expanded: false }).concat(screen.queryAllByRole("button", { expanded: true }));

describe("ExpandRows / ExpandRow", () => {
  it("draws one line per row and no detail while every row is shut", () => {
    render(<Runs />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByText(/detail$/)).toBeNull();
    for (const h of heads()) expect(h).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a row in place on a click, shuts it on a second, and keeps one open at a time", async () => {
    const user = userEvent.setup();
    const seen = vi.fn<(id: string | null) => void>();
    render(<Runs onOpenChange={seen} />);
    await user.click(screen.getByRole("button", { name: "Build" }));
    const build = screen.getByRole("button", { name: "Build" });
    expect(build).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(build.getAttribute("aria-controls") ?? "")).toHaveTextContent("Build detail");
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(screen.queryByText("Build detail")).toBeNull();
    expect(screen.getByText("Test detail")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(screen.queryByText("Test detail")).toBeNull();
    expect(seen.mock.calls.map((c) => c[0])).toEqual(["Build", "Test", null]);
  });

  it("moves with j and k (and the arrows), opens with Enter, shuts with Escape", async () => {
    const user = userEvent.setup();
    render(<Runs />);
    screen.getByRole("button", { name: "Build" }).focus();
    await user.keyboard("j");
    expect(document.activeElement).toHaveAccessibleName("Test");
    await user.keyboard("{ArrowDown}j");
    expect(document.activeElement, "j stops at the last row").toHaveAccessibleName("Ship");
    await user.keyboard("k");
    expect(document.activeElement).toHaveAccessibleName("Test");
    await user.keyboard("{Enter}");
    expect(screen.getByText("Test detail")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Test detail")).toBeNull();
    await user.keyboard(" ");
    expect(screen.getByText("Test detail")).toBeInTheDocument();
  });

  it("never opens a row from an act beside it", async () => {
    const user = userEvent.setup();
    render(<Runs />);
    await user.click(screen.getByRole("button", { name: "Stop Build" }));
    expect(screen.queryByText("Build detail")).toBeNull();
  });

  it("draws an empty list as a list with no rows, for the screen to put its own empty line beside", () => {
    render(<ExpandRows label="Runs">{[]}</ExpandRows>);
    expect(within(screen.getByRole("list", { name: "Runs" })).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("refuses a row drawn outside a list, by name", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<ExpandRow id="x" head="x">x</ExpandRow>)).toThrow(/ExpandRow is drawn outside ExpandRows/);
  });
});

describe("DetailDrawer", () => {
  it("shows only its trigger and count while shut, and the facts once opened", async () => {
    const user = userEvent.setup();
    render(
      <DetailDrawer label="Properties" count={4}>
        <p>Owner Lan</p>
      </DetailDrawer>,
    );
    const trigger = screen.getByRole("button", { name: /Properties/ });
    expect(trigger).toHaveTextContent("Properties4");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Owner Lan")).toBeNull();
    await user.click(trigger);
    const sheet = await screen.findByRole("dialog", { name: "Properties" });
    expect(within(sheet).getByText("Owner Lan")).toBeInTheDocument();
  });

  it("opens from the keyboard and shuts on Escape, handing focus back", async () => {
    const user = userEvent.setup();
    render(
      <DetailDrawer label="Details">
        <button type="button">inside</button>
      </DetailDrawer>,
    );
    await user.tab();
    expect(document.activeElement).toHaveAccessibleName("Details");
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("an empty drawer still opens, holding what the screen gave it", async () => {
    const user = userEvent.setup();
    render(<DetailDrawer label="Details">{null}</DetailDrawer>);
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByRole("dialog", { name: "Details" })).toBeInTheDocument();
  });
});

const shownTip = () => document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');

describe("StatusChip", () => {
  it("shows the state's word on its face and its reason only on hover", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delay={0}>
        <StatusChip tone="err" label="Stuck" reason="Build · 12 min past its lease" />
      </TooltipProvider>,
    );
    const chip = document.querySelector<HTMLElement>("[data-status-chip]");
    expect(chip?.querySelector("[data-testid=status-badge]")).toHaveTextContent("Stuck");
    expect(shownTip()).toBeNull();
    await user.hover(screen.getByText("Stuck"));
    await waitFor(() => expect(shownTip()).toHaveTextContent("Build · 12 min past its lease"));
  });

  it("is reachable by keyboard: focus opens the reason, a screen reader hears it with the state", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delay={0}>
        <StatusChip tone="you" label="Needs you" reason="You · answer a question" />
      </TooltipProvider>,
    );
    await user.tab();
    expect(document.activeElement).toHaveAttribute("data-status-chip");
    await waitFor(() => expect(shownTip()).toHaveTextContent("You · answer a question"));
    expect(document.querySelector(".sr-only")).toHaveTextContent("You · answer a question");
  });

  it("with no reason is a plain chip: nothing to focus, nothing to open", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delay={0}>
        <StatusChip family="run" value="running" />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("status-badge")).toHaveTextContent("Running");
    await user.tab();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("CountSection", () => {
  it("is shut on first draw: its label and count, not its body", () => {
    render(
      <CountSection label="Criteria" count={3}>
        <p>criterion one</p>
      </CountSection>,
    );
    expect(screen.getByRole("button", { name: /Criteria/ })).toHaveTextContent("Criteria3");
    expect(screen.getByRole("button", { name: /Criteria/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("criterion one")).toBeNull();
  });

  it("opens on a click or Enter, and shuts again", async () => {
    const user = userEvent.setup();
    render(
      <CountSection label="Activity" count={14}>
        <p>an event</p>
      </CountSection>,
    );
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByText("an event")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Activity/ }));
    await waitFor(() => expect(screen.queryByText("an event")).toBeNull());
  });

  it("holding nothing is a quiet line with its zero and nothing to open", () => {
    render(
      <CountSection label="Files" count={0}>
        <p>never drawn</p>
      </CountSection>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector("[data-count-section=empty]")).toHaveTextContent("Files0");
    expect(screen.queryByText("never drawn")).toBeNull();
  });

  it("carries one number, what is open, never the total beside it, and opens on settled rows at zero", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CountSection label="Still unclear" count={2} unit="open" holds={3}>
        <p>three questions</p>
      </CountSection>,
    );
    expect(screen.getByRole("button", { name: /Still unclear/ })).toHaveTextContent(/^Still unclear2 open$/);
    rerender(
      <CountSection label="Still unclear" count={0} unit="open" holds={1}>
        <p>one answered</p>
      </CountSection>,
    );
    await user.click(screen.getByRole("button", { name: /Still unclear0 open/ }));
    expect(screen.getByText("one answered")).toBeInTheDocument();
  });
});

function Screen({ acts }: { acts: string[] }) {
  usePageCommands(acts.map((label) => ({ label, icon: "x" as const, onRun: () => ran(label) })));
  return <NextAction label="Approve" onClick={() => ran("Approve")} />;
}
const ran = vi.fn<(act: string) => void>();

function Palette() {
  return <CommandPalette open onClose={() => {}} commands={usePageCommandList()} />;
}

describe("NextAction and the page's ⌘K acts", () => {
  it("draws the one primary act, and runs it", async () => {
    const user = userEvent.setup();
    render(<NextAction label="Triage" onClick={() => ran("Triage")} />);
    const act = screen.getByRole("button", { name: "Triage" });
    expect(act).toHaveAttribute("data-next-action");
    await user.click(act);
    expect(ran).toHaveBeenCalledWith("Triage");
  });

  it("is a link when the act is a place to go, reachable by keyboard", async () => {
    const user = userEvent.setup();
    render(<NextAction label="Open approvals" href="/projects/hop/approvals" />);
    await user.tab();
    expect(document.activeElement).toHaveAccessibleName("Open approvals");
    expect(document.activeElement).toHaveAttribute("href", "/projects/hop/approvals");
  });

  it("with no act and no page acts draws nothing to press", () => {
    render(<NextAction label="Nothing owed" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("lists a screen's secondary acts in the palette under This page, and a quiet more control opens it", async () => {
    const user = userEvent.setup();
    const openPalette = vi.fn();
    render(
      <PageCommandsProvider openPalette={openPalette}>
        <Screen acts={["Pause master", "Copy as Markdown"]} />
        <Palette />
      </PageCommandsProvider>,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("This page")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["Pause master", "Copy as Markdown"]);
    await user.click(within(dialog).getByRole("option", { name: "Pause master" }));
    expect(ran).toHaveBeenCalledWith("Pause master");
  });

  it("carries a quiet more control beside the act that opens the palette, while the screen named any", async () => {
    const user = userEvent.setup();
    const openPalette = vi.fn();
    render(
      <PageCommandsProvider openPalette={openPalette}>
        <Screen acts={["Pause master"]} />
      </PageCommandsProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    expect(openPalette).toHaveBeenCalledOnce();
  });

  it("drops a screen's acts when it leaves, and shows no more control without any", async () => {
    const { rerender } = render(
      <PageCommandsProvider openPalette={() => {}}>
        <Screen acts={["Pause master"]} />
        <Palette />
      </PageCommandsProvider>,
    );
    expect(await screen.findByRole("option", { name: "Pause master" })).toBeInTheDocument();
    rerender(
      <PageCommandsProvider openPalette={() => {}}>
        <Screen acts={[]} />
        <Palette />
      </PageCommandsProvider>,
    );
    await waitFor(() => expect(screen.queryByRole("option", { name: "Pause master" })).toBeNull());
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
});

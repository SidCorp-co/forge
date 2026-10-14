// The row menu is base-ui's Menu: its panel portals to <body>, so a menu opened in a clipping table
// box shows whole (ISS-1172), and the keyboard, dismissal and scroll lock are the library's. These
// pin what the wrapper promises on top: inert items do not run, checked items read as checkboxes,
// a run of grouped items is one labelled group, and the trigger it is given IS the trigger: never
// wrapped in a second element with role=button, which nested one button inside another.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { Button } from "@/design/primitives/button";
import { IconButton } from "@/design/primitives/icon-button";
import { Table, TBody, TD, TR } from "@/design/primitives/table";
import { Menu, type MenuItem } from "./menu";

function InTable({ items }: { items: MenuItem[] }) {
  return (
    <Table data-testid="table">
      <TBody>
        <TR>
          <TD>
            <Menu
              trigger={
                <button type="button" aria-label="Row actions">
                  ⋯
                </button>
              }
              items={items}
            />
          </TD>
        </TR>
      </TBody>
    </Table>
  );
}

const trigger = () => screen.getByRole("button", { name: "Row actions" });

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';

/** Every interactive element that sits inside another interactive element: a screen reader meets
 *  two controls for one, and a keyboard user a stop that does nothing. */
function nestedInteractive(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>(INTERACTIVE)]
    .filter((el) => el.parentElement?.closest(INTERACTIVE))
    .map((el) => `${el.tagName.toLowerCase()} inside ${el.parentElement?.closest(INTERACTIVE)?.tagName.toLowerCase() ?? "?"}`);
}

/** A trigger drawn by a component around its button, as a list's filter is: it hands the menu's props to the button. */
function DotTrigger(props: ComponentProps<"button">) {
  return (
    <span className="relative inline-flex">
      <IconButton {...props} icon="filter" aria-label="Filter" />
      <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2" />
    </span>
  );
}

async function openWithKeyboard(user: ReturnType<typeof userEvent.setup>) {
  trigger().focus();
  await user.keyboard("{Enter}");
  return screen.findByRole("menu");
}

describe("Menu", () => {
  it("opens its panel on <body>, outside the table box that clipped it", async () => {
    const user = userEvent.setup();
    render(<InTable items={[{ label: "Edit" }]} />);
    await user.click(trigger());
    const menu = await screen.findByRole("menu");
    expect(screen.getByTestId("table").parentElement).not.toContainElement(menu);
    expect(document.body).toContainElement(menu);
  });

  it("opened from the keyboard, puts focus on the first item that is not inert", async () => {
    const user = userEvent.setup();
    render(<InTable items={[{ label: "Blocked", disabled: true }, { label: "Edit" }]} />);
    await openWithKeyboard(user);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Edit" })));
  });

  it("runs the item clicked and closes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<InTable items={[{ label: "Edit", onSelect }]} />);
    await user.click(trigger());
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("does not run an inert item, and stays open", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<InTable items={[{ label: "Blocked", disabled: true, onSelect }]} />);
    await user.click(trigger());
    fireEvent.click(await screen.findByRole("menuitem", { name: "Blocked" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("closes on Escape and gives focus back to the trigger", async () => {
    const user = userEvent.setup();
    render(<InTable items={[{ label: "Edit" }]} />);
    await openWithKeyboard(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Tab rather than trapping focus inside it", async () => {
    const user = userEvent.setup();
    render(<InTable items={[{ label: "Edit" }]} />);
    await openWithKeyboard(user);
    await user.keyboard("{Tab}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("moves between items with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<InTable items={[{ label: "Edit" }, { label: "Delete", danger: true }]} />);
    await openWithKeyboard(user);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Edit" })));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Edit" }));
  });

  it("closes on a press outside, and toggles from its trigger", async () => {
    const user = userEvent.setup();
    render(<InTable items={[{ label: "Edit" }]} />);
    await user.click(trigger());
    await screen.findByRole("menu");
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await user.click(trigger());
    await screen.findByRole("menu");
    await user.click(trigger());
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("holds the page still while open, and lets it go once closed", async () => {
    const user = userEvent.setup();
    render(<InTable items={[{ label: "Edit" }]} />);
    await openWithKeyboard(user);
    await waitFor(() => expect(document.body.style.overflowY).toBe("hidden"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.body.style.overflowY).toBe(""));
  });

  it("reports a choice that is on or off as a ticked menuitemcheckbox", async () => {
    const user = userEvent.setup();
    render(<InTable items={[{ label: "Archived", checked: true }, { label: "Alpha", checked: false }, { label: "Edit" }]} />);
    await user.click(trigger());
    expect(await screen.findByRole("menuitemcheckbox", { name: "Archived" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Alpha" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitem", { name: "Edit" })).not.toHaveAttribute("aria-checked");
  });

  it("runs a checkbox item's onSelect when it is toggled", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<InTable items={[{ label: "Archived", checked: false, onSelect }]} />);
    await user.click(trigger());
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Archived" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("labels each run of items sharing a group, and keeps an ungrouped item out of every group", async () => {
    const user = userEvent.setup();
    render(
      <InTable
        items={[
          { label: "Alpha", group: "Project" },
          { label: "Beta", group: "Project" },
          { label: "Platform", group: "Ecosystem" },
          { label: "Edit" },
        ]}
      />,
    );
    await user.click(trigger());
    const project = await screen.findByRole("group", { name: "Project" });
    expect(project).toContainElement(screen.getByRole("menuitem", { name: "Beta" }));
    expect(project).not.toContainElement(screen.getByRole("menuitem", { name: "Platform" }));
    expect(screen.getByRole("group", { name: "Ecosystem" })).toContainElement(screen.getByRole("menuitem", { name: "Platform" }));
    expect(screen.getByRole("menuitem", { name: "Edit" }).closest('[role="group"]')).toBeNull();
  });

  it("makes the trigger it is given the trigger itself: one button, nothing interactive nested in another", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <InTable items={[{ label: "Edit" }]} />
        <Menu trigger={<Button size="sm">Export</Button>} items={[{ label: "PDF" }]} />
        <Menu trigger={<IconButton icon="more" aria-label="More" />} items={[{ label: "Archive" }]} />
        <Menu trigger={<DotTrigger />} items={[{ label: "Open only" }]} />
      </>,
    );
    expect(nestedInteractive(container)).toEqual([]);
    for (const name of ["Row actions", "Export", "More", "Filter"]) {
      const button = screen.getByRole("button", { name });
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("aria-haspopup", "menu");
      expect(button).not.toHaveAttribute("tabindex", "-1");
    }
    // the button is what opens and reports the menu, so its state is the menu's
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    await screen.findByRole("menuitem", { name: "Archive" });
    expect(more).toHaveAttribute("aria-expanded", "true");
  });

  it("opens from a trigger component that hands its props to the button inside it", async () => {
    const user = userEvent.setup();
    render(<Menu trigger={<DotTrigger />} items={[{ label: "Open only" }]} />);
    await user.click(screen.getByRole("button", { name: "Filter" }));
    expect(await screen.findByRole("menuitem", { name: "Open only" })).toBeInTheDocument();
  });
});

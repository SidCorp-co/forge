// The palette is a base-ui dialog around cmdk: it renders on <body> and locks the page's scroll while
// open (ISS-1172). These pin what the wrapper adds: a query matches a command's label or keywords and
// nothing else, the groups keep their fixed order, and running a command closes the palette.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { type Command, CommandPalette } from "./command-palette";

// cm:why cmdk scrolls the selected item into view, and jsdom has no layout to scroll
Element.prototype.scrollIntoView = () => {};

const COMMANDS: Command[] = [
  { label: "Create issue", icon: "plus", group: "actions", keywords: "new file bug" },
  { label: "Go to issues", icon: "list" },
  { label: "Go to runners", icon: "server", keywords: "devices" },
  { label: "Last opened", icon: "clock", group: "recent" },
];

function Harness({ commands = COMMANDS, onClose = vi.fn() }: { commands?: Command[]; onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div data-testid="page">page</div>
      <CommandPalette
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        commands={commands}
      />
    </>
  );
}

const options = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("CommandPalette", () => {
  it("renders on <body>, not inside the element that rendered it", async () => {
    const { container } = render(<Harness />);
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(container).not.toContainElement(dialog);
  });

  it("holds the page still while open, and nothing once closed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByRole("dialog");
    await waitFor(() => expect(document.body.style.overflowY).toBe("hidden"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.body.style.overflowY).toBe(""));
  });

  it("orders the groups recent, navigate, actions whatever order the commands came in", async () => {
    render(<Harness />);
    await screen.findByRole("dialog");
    expect(options()).toEqual(["Last opened", "Go to issues", "Go to runners", "Create issue"]);
  });

  it("matches a query against the label and the keywords, and nothing else", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = await screen.findByPlaceholderText("Search or run a command…");
    await user.type(input, "devices");
    expect(options()).toEqual(["Go to runners"]);
    await user.clear(input);
    await user.type(input, "runners");
    expect(options()).toEqual(["Go to runners"]);
    await user.clear(input);
    await user.type(input, "actions");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });

  it("runs the command chosen with Enter and closes", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} commands={[{ label: "Create issue", icon: "plus", onRun }]} />);
    const input = await screen.findByPlaceholderText("Search or run a command…");
    await user.type(input, "create");
    await user.keyboard("{Enter}");
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("runs the command clicked", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<Harness commands={[{ label: "Go to issues", icon: "list", onRun }]} />);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("option", { name: /Go to issues/ }));
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});

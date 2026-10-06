// The drawer closes on Escape, except where something inside it already took that key to close
// itself: a menu dismissed inside the Ask-agent drawer must not take the conversation, and its draft,
// with it (ISS-1146). A control takes the key by marking it handled (preventDefault) or by stopping
// it; base-ui's own dismissal honours only the second, so the drawer reads the first itself.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { Menu } from "./menu";
import { SlideOver } from "./slide-over";

async function renderDrawer(onInnerKeyDown?: (e: KeyboardEvent) => void) {
  const onClose = vi.fn();
  render(
    <SlideOver open onClose={onClose} title="Drawer">
      <input aria-label="inner" onKeyDown={onInnerKeyDown} />
    </SlideOver>,
  );
  const inner = await screen.findByRole("textbox", { name: "inner" });
  // base-ui moves focus into the popup as it opens; the key is pressed once that has settled
  await waitFor(() => expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement));
  inner.focus();
  expect(document.activeElement).toBe(inner);
  return { onClose, user: userEvent.setup() };
}

describe("SlideOver and Escape", () => {
  it("closes on an Escape nothing inside it took", async () => {
    const { onClose, user } = await renderDrawer();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open when a control inside it marked the Escape handled", async () => {
    const { onClose, user } = await renderDrawer((e) => {
      if (e.key === "Escape") e.preventDefault();
    });
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open when a control inside it stopped the Escape", async () => {
    const { onClose, user } = await renderDrawer((e) => {
      if (e.key === "Escape") e.stopPropagation();
    });
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close on another key", async () => {
    const { onClose, user } = await renderDrawer();
    await user.keyboard("{Enter}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes only the menu open inside it on the first Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <SlideOver open onClose={onClose} title="Drawer">
        <Menu trigger={<button type="button" aria-label="Composer mode">mode</button>} items={[{ label: "Agent" }]} />
      </SlideOver>,
    );
    const trigger = await screen.findByRole("button", { name: "Composer mode" });
    await waitFor(() => expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement));
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from its Close control", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <SlideOver open onClose={onClose} title="Drawer">
        <p>body</p>
      </SlideOver>,
    );
    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("SlideOver and the page's stacking contexts", () => {
  // ISS-1327: rendered inside the sticky issue rail, the fixed drawer was painted in the rail's
  // stacking context, under the sticky issue header. A drawer on `body` is above both.
  it("renders outside the element that rendered it, named by its title", async () => {
    render(
      <div data-testid="sticky-rail" style={{ position: "sticky", top: 0 }}>
        <SlideOver open onClose={() => {}} title="Mark this work merged">
          <p>body</p>
        </SlideOver>
      </div>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Mark this work merged" });
    expect(screen.getByTestId("sticky-rail")).not.toContainElement(dialog);
    expect(document.body).toContainElement(dialog);
  });
});

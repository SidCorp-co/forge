// A long page's contents: beside a rail, a vertical list with the group in view marked as the reader
// scrolls; where there is no rail, one menu control naming that group. jsdom lays nothing out, so each
// group's place on screen is set by hand and a scroll is fired to make the list read it again.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContentsList, ContentsMenu } from "./page-contents";

const ITEMS = [
  { id: "g-a", label: "New features" },
  { id: "g-b", label: "Fixes" },
  { id: "g-c", label: "Still open" },
];

/** Puts each group's top (and bottom) where the test says, as a laid-out page would report it. */
function place(tops: Record<string, number>) {
  for (const [id, top] of Object.entries(tops)) {
    const el = document.getElementById(id);
    if (el) el.getBoundingClientRect = () => ({ top, bottom: top + 200, left: 0, right: 0, width: 0, height: 200, x: 0, y: top, toJSON: () => ({}) });
  }
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      {ITEMS.map((i) => (
        <section key={i.id} id={i.id} />
      ))}
    </>
  );
}

const here = () => screen.getAllByRole("link").find((a) => a.getAttribute("aria-current") === "location")?.textContent;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ContentsList", () => {
  it("links each group to where it starts, in the order given", () => {
    render(<Page><ContentsList items={ITEMS} label="On this page" /></Page>);
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["#g-a", "#g-b", "#g-c"]);
    expect(screen.getByRole("navigation", { name: "On this page" })).toBeTruthy();
  });

  it("marks the last group whose top has passed the marker line, and moves the mark as the page scrolls", async () => {
    render(<Page><ContentsList items={ITEMS} label="On this page" /></Page>);
    // marker line: 30% of a 768px window, so 230px; the third group is still below the window
    place({ "g-a": -600, "g-b": 120, "g-c": 900 });
    act(() => void fireEvent.scroll(document));
    await waitFor(() => expect(here()).toBe("Fixes"));
    place({ "g-a": -1400, "g-b": -680, "g-c": 100 });
    act(() => void fireEvent.scroll(document));
    await waitFor(() => expect(here()).toBe("Still open"));
    // above the marker line nothing has passed yet: the first group stands
    place({ "g-a": 300, "g-b": 1000, "g-c": 1800 });
    act(() => void fireEvent.scroll(document));
    await waitFor(() => expect(here()).toBe("New features"));
  });

  it("marks the last group once the page has scrolled to its end, though its top never reaches the line", async () => {
    render(<Page><ContentsList items={ITEMS} label="On this page" /></Page>);
    // jsdom's page has no height, so it reads as scrolled to its end
    place({ "g-a": -900, "g-b": 100, "g-c": 500 });
    act(() => void fireEvent.scroll(document));
    await waitFor(() => expect(here()).toBe("Still open"));
  });

  it("draws nothing for fewer than two groups: a contents of one names nothing to move between", () => {
    const { container } = render(<ContentsList items={ITEMS.slice(0, 1)} label="On this page" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("ContentsMenu", () => {
  it("is one control naming the group in view, never a row of links", async () => {
    render(<Page><ContentsMenu items={ITEMS} label="On this page" testId="menu" /></Page>);
    place({ "g-a": -600, "g-b": 120, "g-c": 900 });
    act(() => void fireEvent.scroll(document));
    const nav = screen.getByTestId("menu");
    expect(nav.querySelectorAll("a")).toHaveLength(0);
    expect(nav.querySelectorAll("button")).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("menu-trigger")).toHaveAccessibleName("On this page: Fixes"));
  });
});

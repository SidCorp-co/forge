// @vitest-environment jsdom
//
// ISS-1169: a long list inside a form is searchable and collapsed. With 24 projects the picker opens on
// the chosen projects and a search field, and the checkboxes appear only for a search or when asked for.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectPicker } from "./project-picker";

expect.extend(matchers);
afterEach(cleanup);

const PROJECTS = Array.from({ length: 24 }, (_, i) => ({ id: `p${i}`, name: i === 7 ? "dodgeprint-api" : `project-${i}` }));

function Harness({ initial = [] as string[], onChange }: { initial?: string[]; onChange?: (ids: string[]) => void }) {
  const [picked, setPicked] = useState(initial);
  return (
    <ProjectPicker
      projects={PROJECTS}
      picked={picked}
      onToggle={(id) =>
        setPicked((cur) => {
          const next = cur.includes(id) ? cur.filter((p) => p !== id) : [...cur, id];
          onChange?.(next);
          return next;
        })
      }
    />
  );
}

describe("ProjectPicker", () => {
  it("opens on a search field and what is chosen, with none of the 24 checkboxes in the page", () => {
    render(<Harness initial={["p3"]} />);
    expect(screen.getByRole("textbox", { name: "Search projects" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Chosen projects" })).getByText("project-3")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("says nothing is chosen yet when nothing is", () => {
    render(<Harness />);
    expect(screen.getByText("No project chosen yet.")).toBeInTheDocument();
  });

  it("narrows to the names that match a search, case-insensitively", () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "DODGE" } });
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-checked"))).toEqual(["false"]);
    expect(screen.getByRole("checkbox", { name: "dodgeprint-api" })).toBeInTheDocument();
  });

  it("says when no project matches the search", () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "zzz" } });
    expect(screen.getByText(/No project matches/)).toBeInTheDocument();
  });

  it("adds a ticked project to the chosen list, and removing it from there unticks it", () => {
    const seen: string[][] = [];
    render(<Harness onChange={(ids) => seen.push(ids)} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "dodge" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "dodgeprint-api" }));
    expect(within(screen.getByRole("list", { name: "Chosen projects" })).getByText("dodgeprint-api")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "dodgeprint-api" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Remove dodgeprint-api" }));
    expect(screen.getByRole("checkbox", { name: "dodgeprint-api" })).toHaveAttribute("aria-checked", "false");
    expect(seen).toEqual([["p7"], []]);
  });

  it("keeps a chosen project chosen when the search moves on to another", () => {
    render(<Harness initial={["p7"]} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "project-1" } });
    expect(within(screen.getByRole("list", { name: "Chosen projects" })).getByText("dodgeprint-api")).toBeInTheDocument();
  });

  it("shows the whole list, scrollable, only when asked, and hides it again", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Show all 24" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(24);
    fireEvent.click(screen.getByRole("button", { name: "Hide the list" }));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});

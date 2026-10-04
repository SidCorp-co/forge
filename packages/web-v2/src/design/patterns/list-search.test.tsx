// @vitest-environment jsdom
//
// The one search box every list draws: named after what it searches, starting from the URL's text.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ListSearch } from "./list-search";

expect.extend(matchers);
afterEach(cleanup);

describe("ListSearch", () => {
  it("names itself after the noun and starts from the text it is given", () => {
    render(<ListSearch noun="modules" value="reports" onChange={() => {}} />);
    const box = screen.getByRole("searchbox", { name: "Search modules" });
    expect(box).toHaveAttribute("placeholder", "Search modules…");
    expect(box).toHaveValue("reports");
  });

  it("reports every edit as the text, empty when cleared", () => {
    const seen: string[] = [];
    render(<ListSearch noun="issues" value="" onChange={(t) => seen.push(t)} />);
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "zalo" } });
    fireEvent.change(box, { target: { value: "" } });
    expect(seen).toEqual(["zalo", ""]);
  });
});

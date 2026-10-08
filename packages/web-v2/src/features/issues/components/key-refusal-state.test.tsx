// @vitest-environment jsdom
//
// ISS-1334: the refusal printed its key's backticks raw and offered Clear search under a plus.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { KeyRefusalState } from "./key-refusal-state";

expect.extend(matchers);
afterEach(cleanup);

const SAID =
  "`QAA-1` names the prefix `QAA`, which belonged to a project that no longer exists — this project answers to `ISS`.";

it("shows the key and prefixes as inline code with no backtick on screen", () => {
  const { container } = render(<KeyRefusalState message={SAID} onClear={vi.fn()} />);

  expect(screen.getByText("QAA-1").tagName).toBe("CODE");
  expect(screen.getByText("ISS").tagName).toBe("CODE");
  expect(container.textContent).not.toContain("`");
});

it("offers Clear search with no plus and no Retry", () => {
  const onClear = vi.fn();
  render(<KeyRefusalState message={SAID} onClear={onClear} />);

  const clear = screen.getByRole("button", { name: "Clear search" });
  expect(clear.querySelector("svg")).toBeNull();
  expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  fireEvent.click(clear);
  expect(onClear).toHaveBeenCalledOnce();
});

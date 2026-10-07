// journey-ba2 N4: a person filing or routing feedback named issues by typing keys blind. The picker
// searches the project's issues by key and title, and a write names only an issue a person picked.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { IssuePick } from "./api";
import { IssuePicker } from "./issue-picker";

const ROWS = [
  { id: "i52", displayId: "ISS-52", title: "Snooze by the item's owner" },
  { id: "i74", displayId: "ISS-74", title: "Attention Queue screen" },
  { id: "i49", displayId: "ISS-49", title: "Attention Queue design" },
];

function issueSearch(path: string) {
  const url = new URL(path, "http://forge.test");
  if (url.pathname !== "/projects/p1/issues/search") return undefined;
  const key = url.searchParams.get("key");
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  if (key === "REQ-3") {
    return { status: 400, body: { code: "VALIDATION_ERROR", message: "key: REQ-3 is not an issue key of this project" } };
  }
  const items = key
    ? ROWS.filter((r) => r.displayId === key)
    : q === "iss-52"
      ? ROWS.filter((r) => r.displayId !== "ISS-52")
      : ROWS.filter((r) => r.title.toLowerCase().includes(q));
  return { body: { items, total: items.length } };
}

function Harness({ single = false, seen }: { single?: boolean; seen: (v: IssuePick[]) => void }) {
  const [value, setValue] = useState<IssuePick[]>([]);
  return (
    <IssuePicker
      projectId="p1"
      value={value}
      single={single}
      ariaLabel="Issues"
      onChange={(next) => {
        setValue(next);
        seen(next);
      }}
    />
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("the issue picker", () => {
  it("lists the issue a typed key names first, before the issues that merely mention it", async () => {
    fakeCore((c) => issueSearch(c.path));
    renderWithQuery(<Harness seen={() => {}} />);
    await userEvent.type(screen.getByRole("combobox", { name: "Issues" }), "ISS-52");
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "ISS-52Snooze by the item's owner",
      "ISS-74Attention Queue screen",
      "ISS-49Attention Queue design",
    ]);
  });

  it("finds issues by words of their title and hands back the key and title picked", async () => {
    const calls = fakeCore((c) => issueSearch(c.path));
    const seen = vi.fn();
    renderWithQuery(<Harness seen={seen} />);
    // The list a typed word shows is the debounced search's, and the previous word's list stays up
    // until it lands, so a click taken from whatever option appears first can hit a list about to be
    // replaced. Each pick waits until the search for the word typed has been asked and answered.
    const typedAndSearched = async (word: string, keys: string[]) => {
      await userEvent.type(screen.getByRole("combobox", { name: "Issues" }), word);
      await waitFor(() => expect(calls.some((c) => c.path.includes(`q=${word}`))).toBe(true));
      await waitFor(() => expect(screen.queryByText(/searching/i)).toBeNull());
      await waitFor(() => expect(screen.getAllByRole("option").map((o) => o.textContent?.slice(0, 6))).toEqual(keys));
    };
    await typedAndSearched("queue", ["ISS-74", "ISS-49"]);
    await userEvent.click(screen.getByRole("option", { name: /ISS-49/ }));
    await typedAndSearched("screen", ["ISS-74", "ISS-49"]);
    await userEvent.click(screen.getByRole("option", { name: /ISS-74/ }));
    expect(seen).toHaveBeenLastCalledWith([
      { key: "ISS-49", title: "Attention Queue design" },
      { key: "ISS-74", title: "Attention Queue screen" },
    ]);
  });

  it("keeps one pick only where one issue is asked for", async () => {
    fakeCore((c) => issueSearch(c.path));
    const seen = vi.fn();
    renderWithQuery(<Harness single seen={seen} />);
    await userEvent.type(screen.getByRole("combobox", { name: "Issues" }), "queue");
    await userEvent.click(await screen.findByRole("option", { name: /ISS-49/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Issues" }), "snooze");
    await userEvent.click(await screen.findByRole("option", { name: /ISS-52/ }));
    expect(seen).toHaveBeenLastCalledWith([{ key: "ISS-52", title: "Snooze by the item's owner" }]);
  });

  it("says nothing matched rather than leaving an empty list", async () => {
    fakeCore((c) => issueSearch(c.path));
    renderWithQuery(<Harness seen={() => {}} />);
    await userEvent.type(screen.getByRole("combobox", { name: "Issues" }), "zebra");
    await waitFor(() => expect(screen.getByText("No issue of this project matches “zebra”")).toBeTruthy());
    expect(screen.queryAllByRole("option")).toEqual([]);
  });

  it("names core's refusal of a key that is not this project's issue", async () => {
    fakeCore((c) => issueSearch(c.path));
    renderWithQuery(<Harness seen={() => {}} />);
    await userEvent.type(screen.getByRole("combobox", { name: "Issues" }), "REQ-3");
    expect(await screen.findByTestId("issue-picker-refusal")).toHaveTextContent("REQ-3 is not an issue key of this project");
  });
});

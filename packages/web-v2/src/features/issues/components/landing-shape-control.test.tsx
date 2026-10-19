// @vitest-environment jsdom
//
// A person declares where an issue's own work lands on the issue page, through the door an agent
// uses (`PATCH /api/issues/:id` `landingShape`). Where the door refuses, the refusal is said beside
// the control, by name and with the steps, rather than as a code or a toast.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LandingShape } from "../types";
import { LandingShapeControl } from "./landing-shape-control";

expect.extend(matchers);

const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

const fetchMock = vi.fn();

beforeEach(() => {
  // jsdom lays nothing out; the select's list scrolls its active option into view.
  Element.prototype.scrollIntoView = vi.fn();
  toast.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(cleanup);

function draw(declared: LandingShape | null, effective: LandingShape = "git", disabled = false) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LandingShapeControl issueId="i1" declared={declared} effective={effective} disabled={disabled} />
    </QueryClientProvider>,
  );
}

function choose(label: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Work lands" }));
  fireEvent.click(screen.getByRole("option", { name: label }));
}

const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

describe("the Work lands control", () => {
  it("shows an issue with no declaration of its own as following its project, naming the lane", () => {
    draw(null, "outside_git");
    expect(screen.getByRole("combobox", { name: "Work lands" })).toHaveTextContent("Project: outside git");
  });

  it("shows an issue's own declaration", () => {
    draw("git");
    expect(screen.getByRole("combobox", { name: "Work lands" })).toHaveTextContent("In git");
  });

  it("declares the issue's own landing shape through PATCH /api/issues/:id", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "i1" }), { status: 200 }));
    draw(null);
    choose("In git");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/issues\/i1$/);
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    expect(sentBody()).toEqual({ landingShape: "git" });
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Where its work lands is saved", tone: "success" }));
  });

  it("clears the declaration back to the project's shape with null", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "i1" }), { status: 200 }));
    draw("outside_git");
    choose("As the project");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ landingShape: null });
  });

  it("says the door's refusal while a merge mark stands, by name and with the steps", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "LANDING_SHAPE_MARK_STANDS",
          message: "this issue carries a merged mark (`asserted`) ... `unmark` it first",
          details: { held: null, sent: "git", mark: "asserted", route: ["unmark", "landingShape"] },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    draw(null);
    choose("In git");
    const said = await screen.findByTestId("landing-shape-refusal");
    expect(said).toHaveTextContent(
      "Nothing changed: this issue carries a merge mark, and a mark is judged on where its work landed when it was made. Press Unmark, set Work lands again, then mark it merged again.",
    );
    expect(said.textContent).not.toMatch(/LANDING_SHAPE_MARK_STANDS|`|unmark/);
    expect(toast).not.toHaveBeenCalled();
  });

  it("takes no change while the rail is locked", () => {
    draw(null, "git", true);
    expect(screen.getByRole("combobox", { name: "Work lands" })).toBeDisabled();
  });
});

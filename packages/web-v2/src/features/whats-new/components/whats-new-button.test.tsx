import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { entry, feedOf } from "../fixtures";
import { WhatsNewButton } from "./whats-new-button";

const recent = new Date(Date.now() - 3_600_000).toISOString();

describe("the What's new rail entry", () => {
  it("wears a dot while anything is unread, and opening it moves the seen mark to now and clears the dot", async () => {
    const calls = fakeCore((call) => {
      if (call.method === "GET" && call.path.startsWith("/me/whats-new")) {
        return { body: feedOf([entry("ISS-1", "new", recent), entry("ISS-2", "fixed", recent)]) };
      }
      if (call.method === "PUT" && call.path === "/me/product-state/whats_new_seen_at") {
        return { body: { key: "whats_new_seen_at", value: call.body, updatedAt: new Date().toISOString() } };
      }
      return undefined;
    });
    renderWithQuery(<WhatsNewButton />);
    expect(await screen.findByTestId("whats-new-dot")).toBeInTheDocument();
    expect(screen.queryByText("2")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /What's new/ }));
    await waitFor(() => expect(screen.queryByTestId("whats-new-dot")).toBeNull());
    const put = calls.find((c) => c.method === "PUT")?.body as { value: { at: string } } | undefined;
    expect(put).toEqual({ value: { at: expect.any(String) } });
    expect(Date.now() - Date.parse(put?.value.at ?? "")).toBeLessThan(10_000);
    expect(screen.getByTestId("whats-new-since")).toHaveTextContent("2 changes");
  });

  it("wears no dot when nothing is unread", async () => {
    fakeCore((call) => (call.method === "GET" ? { body: feedOf([entry("ISS-1", "new", recent, { unread: false })]) } : undefined));
    renderWithQuery(<WhatsNewButton />);
    await screen.findByRole("button", { name: "What's new" });
    expect(screen.queryByTestId("whats-new-dot")).toBeNull();
  });
});

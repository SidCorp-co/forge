import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { entry, feedOf } from "../fixtures";
import { WhatsNewButton } from "./whats-new-button";

const recent = new Date(Date.now() - 3_600_000).toISOString();

const summaryOf = (feed: ReturnType<typeof feedOf>) => ({ version: feed.version, seenAt: feed.seenAt, unread: feed.unread, counts: feed.counts });

describe("the What's new rail entry", () => {
  it("reads only the summary with the page, and the feed once, when it opens", async () => {
    const feed = feedOf([entry("ISS-1", "new", recent), entry("ISS-2", "fixed", recent)]);
    const calls = fakeCore((call) => {
      if (call.path === "/me/whats-new/summary") return { body: summaryOf(feed) };
      if (call.path.startsWith("/me/whats-new?")) return { body: feed };
      if (call.method === "PUT") return { body: { key: "whats_new_seen_at", value: call.body, updatedAt: new Date().toISOString() } };
      return undefined;
    });
    renderWithQuery(<WhatsNewButton />);
    expect(await screen.findByTestId("whats-new-dot")).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toEqual(["/me/whats-new/summary"]);

    await userEvent.click(screen.getByRole("button", { name: /What's new/ }));
    expect(await screen.findByTestId("whats-new-since")).toHaveTextContent("2 changes");
    expect(calls.filter((c) => c.path.startsWith("/me/whats-new?"))).toHaveLength(1);
  });

  it("wears a dot while anything is unread, and opening it moves the seen mark to now and clears the dot", async () => {
    const feed = feedOf([entry("ISS-1", "new", recent), entry("ISS-2", "fixed", recent)]);
    const calls = fakeCore((call) => {
      if (call.method === "GET" && call.path === "/me/whats-new/summary") return { body: summaryOf(feed) };
      if (call.method === "GET" && call.path.startsWith("/me/whats-new")) return { body: feed };
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
    const feed = feedOf([entry("ISS-1", "new", recent, { unread: false })]);
    fakeCore((call) => (call.method === "GET" ? { body: call.path.endsWith("/summary") ? summaryOf(feed) : feed } : undefined));
    renderWithQuery(<WhatsNewButton />);
    await screen.findByRole("button", { name: "What's new" });
    expect(screen.queryByTestId("whats-new-dot")).toBeNull();
  });
});

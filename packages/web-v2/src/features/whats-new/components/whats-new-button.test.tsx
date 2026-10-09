import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { feedOf, releaseOf, summaryOf } from "../fixtures";
import { forgetOpenedWhatsNew, WhatsNewButton } from "./whats-new-button";

beforeEach(() => forgetOpenedWhatsNew());

function serve(feed: ReturnType<typeof feedOf>) {
  return fakeCore((call) => {
    if (call.method === "GET" && call.path === "/me/whats-new/summary") return { body: summaryOf(feed) };
    if (call.method === "GET" && call.path === "/me/whats-new") return { body: feed };
    if (call.method === "PUT" && call.path === "/me/product-state/whats_new_seen_at") {
      return { body: { key: "whats_new_seen_at", value: (call.body as { value: unknown }).value, updatedAt: new Date().toISOString() } };
    }
    return undefined;
  });
}

describe("the What's new rail entry", () => {
  it("opens by itself once the summary says the serving release is owed, and writes nothing until it is closed", async () => {
    const calls = serve(feedOf());
    renderWithQuery(<WhatsNewButton />);
    expect(await screen.findByTestId("whats-new-release")).toHaveTextContent("Release 0.4.0-dev.9");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(calls.filter((c) => c.path === "/me/whats-new")).toHaveLength(1);
  });

  it("writes the mark naming the release and its environment on close, which clears the dot", async () => {
    const calls = serve(feedOf());
    renderWithQuery(<WhatsNewButton />);
    await screen.findByTestId("whats-new-release");
    expect(screen.getByTestId("whats-new-dot")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    const put = calls.find((c) => c.method === "PUT")?.body as { value: { at: string; release: { environment: string; version: string; at: string } } };
    expect(put.value.release).toEqual({ environment: "dev", version: "0.4.0-dev.9", at: put.value.at });
    await waitFor(() => expect(screen.queryByTestId("whats-new-dot")).toBeNull());
  });

  it("opens by itself once, not again for the same release when the page is read again", async () => {
    serve(feedOf());
    const first = renderWithQuery(<WhatsNewButton />);
    await screen.findByTestId("whats-new-release");
    first.unmount();
    renderWithQuery(<WhatsNewButton />);
    await screen.findByTestId("whats-new-dot");
    expect(screen.queryByTestId("whats-new-release")).toBeNull();
  });

  it("opens nothing and wears no dot when the release is not owed, and by hand writes nothing on close", async () => {
    const calls = serve(feedOf(releaseOf({ owed: false })));
    renderWithQuery(<WhatsNewButton />);
    await screen.findByRole("button", { name: "What's new" });
    expect(screen.queryByTestId("whats-new-dot")).toBeNull();
    expect(screen.queryByTestId("whats-new-release")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "What's new" }));
    await screen.findByTestId("whats-new-release");
    await userEvent.keyboard("{Escape}");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("opens nothing for an instance that serves no release", async () => {
    serve(feedOf(null));
    renderWithQuery(<WhatsNewButton />);
    await screen.findByRole("button", { name: "What's new" });
    expect(screen.queryByTestId("whats-new-dot")).toBeNull();
    expect(screen.queryByTestId("whats-new-panel")).toBeNull();
  });
});

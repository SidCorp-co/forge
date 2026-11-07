import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { feedOf, releaseOf, summaryOf } from "../fixtures";
import { forgetOpenedWhatsNew, WhatsNewButton } from "./whats-new-button";

beforeEach(() => forgetOpenedWhatsNew());

/** A core that keeps the mark: once a PUT names the serving release, the release is no longer owed. */
function serve(feed: ReturnType<typeof feedOf>) {
  let seen = false;
  const now = () => (seen && feed.release ? feedOf(releaseOf({ ...feed.release, owed: false })) : feed);
  return fakeCore((call) => {
    if (call.method === "GET" && call.path === "/me/whats-new/summary") return { body: summaryOf(now()) };
    if (call.method === "GET" && call.path === "/me/whats-new") return { body: now() };
    if (call.method === "PUT" && call.path === "/me/product-state/whats_new_seen_at") {
      seen = true;
      return { body: { key: "whats_new_seen_at", value: (call.body as { value: unknown }).value, updatedAt: new Date().toISOString() } };
    }
    return undefined;
  });
}

describe("the What's new rail entry", () => {
  // REQ-40 BC-10: people see What's new once per instance after a release reaches it. Seen is when it
  // shows the release, never only a close: on dev.567 a person who left it open, or reloaded, or signed
  // in again, had it open by itself on every page load (ISS-1073 round 3).
  it("opens by itself once the summary says the serving release is owed, and marks the release seen as it shows it", async () => {
    const calls = serve(feedOf());
    renderWithQuery(<WhatsNewButton />);
    expect(await screen.findByTestId("whats-new-release")).toHaveTextContent("Release 0.4.0-dev.9");
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    expect(calls.filter((c) => c.path === "/me/whats-new")).toHaveLength(1);
  });

  it("opens by itself no more in a fresh page or after sign-in once shown, closed or not", async () => {
    const calls = serve(feedOf());
    const first = renderWithQuery(<WhatsNewButton />);
    await screen.findByTestId("whats-new-release");
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    // a reload or a new sign-in: this tab's memory is gone, only core's mark remains
    first.unmount();
    forgetOpenedWhatsNew();
    renderWithQuery(<WhatsNewButton />);
    await screen.findByRole("button", { name: "What's new" });
    await waitFor(() => expect(calls.filter((c) => c.path === "/me/whats-new/summary")).toHaveLength(2));
    expect(screen.queryByTestId("whats-new-panel")).toBeNull();
    expect(screen.queryByTestId("whats-new-dot")).toBeNull();
  });

  it("writes the mark naming the release and its environment once, which clears the dot, and the close writes no second", async () => {
    const calls = serve(feedOf());
    renderWithQuery(<WhatsNewButton />);
    await screen.findByTestId("whats-new-release");
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
    await screen.findByRole("button", { name: /What's new/ });
    expect(screen.queryByTestId("whats-new-panel")).toBeNull();
  });

  it("opens one panel however many entries are mounted (the sidebar's and the layout's)", async () => {
    serve(feedOf());
    renderWithQuery(
      <>
        <WhatsNewButton />
        <WhatsNewButton compact />
      </>,
    );
    await screen.findByTestId("whats-new-release");
    expect(screen.getAllByTestId("whats-new-panel")).toHaveLength(1);
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
